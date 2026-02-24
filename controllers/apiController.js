const axios = require('axios');
const { User, Session, Setting } = require('../models');
const { validateCPF } = require('../utils/cpfValidator');
const sessionService = require('../services/sessionService');
const mikrotikService = require('../services/mikrotikService');

async function getOrgSettings() {
  const [orgName, orgLogo, bgColor1, bgColor2] = await Promise.all([
    Setting.get('organization_name', 'Hospital Beneficiente Portuguesa'),
    Setting.get('organization_logo', ''),
    Setting.get('portal_bg_color_1', '#0d4e8b'),
    Setting.get('portal_bg_color_2', '#1a7bc4')
  ]);
  return { orgName, orgLogo, bgColor1, bgColor2 };
}

// Converte data de DD/MM/AAAA para YYYY-MM-DD (retorna null se inválida ou futura)
function parseDateBR(str) {
  if (!str || str.length !== 10) return null;
  const [d, m, y] = str.split('/');
  if (!d || !m || !y || y.length !== 4) return null;
  const year = +y;
  if (year < 1900 || year > 9999) return null;
  const date = new Date(year, +m - 1, +d);
  if (date.getFullYear() !== year || date.getMonth() !== +m - 1 || date.getDate() !== +d) return null;
  if (date >= new Date()) return null; // data futura ou hoje não é válida
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function calcIdade(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const hoje = new Date();
  let age = hoje.getFullYear() - y;
  const md = hoje.getMonth() + 1 - m;
  if (md < 0 || (md === 0 && hoje.getDate() < d)) age--;
  return age;
}

exports.register = async (req, res) => {
  const {
    nome_completo, cpf, email, telefone,
    cep, logradouro, bairro, cidade, estado,
    numero, complemento, mac, ip, linkOrig,
    data_nascimento, nome_mae, lgpd_consent
  } = req.body;

  const renderError = async (error) => {
    const org = await getOrgSettings();
    res.render('portal', { mac: mac || '', ip: ip || '', username: '', linkOrig: linkOrig || '', error, activeTab: 'cadastro', ...org });
  };

  try {
    if (!lgpd_consent) return await renderError('Você deve aceitar a Política de Privacidade para continuar.');

    if (!cpf) return await renderError('CPF é obrigatório.');
    const cpfClean = cpf.replace(/\D/g, '');

    if (!validateCPF(cpfClean)) return await renderError('CPF inválido. Verifique e tente novamente.');

    // Validar data de nascimento
    if (!data_nascimento) return await renderError('Data de nascimento é obrigatória.');
    const dataNascISO = parseDateBR(data_nascimento);
    if (!dataNascISO) return await renderError('Data de nascimento inválida. Use o formato DD/MM/AAAA.');

    const idade = calcIdade(dataNascISO);
    if (idade < 18 && (!nome_mae || !nome_mae.trim())) {
      return await renderError('Para menores de 18 anos, o nome completo da mãe é obrigatório.');
    }

    if (!nome_completo || !email || !telefone || !cep || !numero) {
      return await renderError('Todos os campos obrigatórios devem ser preenchidos.');
    }

    const existingUser = await User.findOne({ where: { cpf: cpfClean } });

    // CPF já existe e já tem data de nascimento → bloquear (deve usar login)
    if (existingUser && existingUser.data_nascimento) {
      return await renderError('CPF já cadastrado. Use a aba "Já tenho cadastro" para acessar.');
    }

    let user;
    let isNewUser = true;

    if (existingUser && !existingUser.data_nascimento) {
      // Re-cadastro: usuário antigo sem data de nascimento — atualiza dados
      await existingUser.update({
        nome_completo: nome_completo.trim(),
        email: email.trim(),
        telefone: telefone.replace(/\D/g, ''),
        cep: cep.replace(/\D/g, ''),
        logradouro, bairro, cidade, estado,
        numero: numero.trim(),
        complemento: complemento ? complemento.trim() : null,
        data_nascimento: dataNascISO,
        nome_mae: idade < 18 ? nome_mae.trim() : null,
        lgpd_accepted_at: new Date()
      });
      user = existingUser;
      isNewUser = false;
    } else {
      user = await User.create({
        nome_completo: nome_completo.trim(),
        cpf: cpfClean,
        email: email.trim(),
        telefone: telefone.replace(/\D/g, ''),
        cep: cep.replace(/\D/g, ''),
        logradouro, bairro, cidade, estado,
        numero: numero.trim(),
        complemento: complemento ? complemento.trim() : null,
        data_nascimento: dataNascISO,
        nome_mae: idade < 18 ? nome_mae.trim() : null,
        lgpd_accepted_at: new Date()
      });
    }

    const portalSession = await sessionService.createSession(user.id, mac, ip);

    const authorized = await mikrotikService.authorizeUser(mac, ip, cpfClean, nome_completo);
    if (!authorized) {
      await portalSession.destroy();
      if (isNewUser) {
        await user.destroy();
      } else {
        // Re-cadastro: reverter data_nascimento para null para o usuário poder tentar novamente
        await user.update({ data_nascimento: null, nome_mae: null });
      }
      console.warn(`[Cadastro] Mikrotik recusou autorização para ${cpfClean} - cadastro revertido`);
      return await renderError('Não foi possível liberar o acesso à rede. Tente novamente em alguns instantes.');
    }

    console.log(`[Cadastro] Usuário ${isNewUser ? 'cadastrado' : 'atualizado'}: ${cpfClean} - ${nome_completo}`);
    res.redirect(`/success?nome=${encodeURIComponent(nome_completo)}&linkOrig=${encodeURIComponent(linkOrig || '')}`);
  } catch (err) {
    console.error('[Cadastro] Erro:', err.message);
    try { await renderError('Erro interno. Tente novamente.'); } catch (_) {
      if (!res.headersSent) res.status(500).send('Erro interno.');
    }
  }
};

exports.login = async (req, res) => {
  const { cpf, mac, ip, linkOrig, data_nascimento } = req.body;

  const renderError = async (error) => {
    const org = await getOrgSettings();
    res.render('portal', { mac: mac || '', ip: ip || '', username: '', linkOrig: linkOrig || '', error, activeTab: 'login', ...org });
  };

  try {
    if (!cpf) return await renderError('CPF é obrigatório.');
    const cpfClean = cpf.replace(/\D/g, '');

    if (!validateCPF(cpfClean)) return await renderError('CPF inválido.');

    if (!data_nascimento) return await renderError('Data de nascimento é obrigatória.');
    const dataNascISO = parseDateBR(data_nascimento);
    if (!dataNascISO) return await renderError('Data de nascimento inválida. Use o formato DD/MM/AAAA.');

    const user = await User.findOne({ where: { cpf: cpfClean } });
    if (!user) return await renderError('CPF ou data de nascimento incorretos.');

    // Usuário antigo sem data de nascimento → orientar recadastro
    if (!user.data_nascimento) {
      return await renderError('Seus dados precisam ser atualizados. Use a aba "Primeiro Acesso" para se recadastrar.');
    }

    // Comparar data de nascimento
    if (user.data_nascimento !== dataNascISO) {
      return await renderError('CPF ou data de nascimento incorretos.');
    }

    let portalSession = await sessionService.getActiveSession(user.id);
    const isNewSession = !portalSession;
    if (!portalSession) {
      portalSession = await sessionService.createSession(user.id, mac, ip);
    }

    const authorized = await mikrotikService.authorizeUser(mac, ip, cpfClean, user.nome_completo);
    if (!authorized) {
      if (isNewSession) await portalSession.destroy();
      console.warn(`[Login] Mikrotik recusou autorização para ${cpfClean}`);
      return await renderError('Não foi possível liberar o acesso à rede. Tente novamente em alguns instantes.');
    }

    console.log(`[Login] Usuário autenticado: ${cpfClean} - ${user.nome_completo}`);
    res.redirect(`/success?nome=${encodeURIComponent(user.nome_completo)}&linkOrig=${encodeURIComponent(linkOrig || '')}`);
  } catch (err) {
    console.error('[Login] Erro:', err.message);
    try { await renderError('Erro interno. Tente novamente.'); } catch (_) {
      if (!res.headersSent) res.status(500).send('Erro interno.');
    }
  }
};

exports.consultaCep = async (req, res) => {
  try {
    const cep = req.params.cep.replace(/\D/g, '');
    if (cep.length !== 8) {
      return res.status(400).json({ error: 'CEP inválido' });
    }

    const response = await axios.get(`https://viacep.com.br/ws/${cep}/json/`, { timeout: 5000 });

    if (response.data.erro) {
      return res.status(404).json({ error: 'CEP não encontrado' });
    }

    res.json(response.data);
  } catch (err) {
    console.error('[CEP] Erro:', err.message);
    res.status(500).json({ error: 'Erro ao consultar CEP' });
  }
};
