const axios = require('axios');
const { User, Session } = require('../models');
const { validateCPF } = require('../utils/cpfValidator');
const sessionService = require('../services/sessionService');
const mikrotikService = require('../services/mikrotikService');

exports.register = async (req, res) => {
  try {
    const {
      nome_completo, cpf, email, telefone,
      cep, logradouro, bairro, cidade, estado,
      numero, complemento, mac, ip, linkOrig
    } = req.body;

    // Remove formatação do CPF
    if (!cpf) {
      return res.render('portal', {
        mac, ip, username: '', linkOrig,
        error: 'CPF é obrigatório.'
      });
    }
    const cpfClean = cpf.replace(/\D/g, '');

    // Validação do CPF
    if (!validateCPF(cpfClean)) {
      return res.render('portal', {
        mac, ip, username: '', linkOrig,
        error: 'CPF inválido. Verifique e tente novamente.'
      });
    }

    // Verifica se CPF já existe
    const existingUser = await User.findOne({ where: { cpf: cpfClean } });
    if (existingUser) {
      return res.render('portal', {
        mac, ip, username: '', linkOrig,
        error: 'CPF já cadastrado. Use a aba "Já tenho cadastro" para acessar.'
      });
    }

    // Validações básicas
    if (!nome_completo || !email || !telefone || !cep || !numero) {
      return res.render('portal', {
        mac, ip, username: '', linkOrig,
        error: 'Todos os campos obrigatórios devem ser preenchidos.'
      });
    }

    // Cria o usuário
    const user = await User.create({
      nome_completo: nome_completo.trim(),
      cpf: cpfClean,
      email: email.trim(),
      telefone: telefone.replace(/\D/g, ''),
      cep: cep.replace(/\D/g, ''),
      logradouro, bairro, cidade, estado,
      numero: numero.trim(),
      complemento: complemento ? complemento.trim() : null
    });

    // Cria sessão
    await sessionService.createSession(user.id, mac, ip);

    // Autoriza no Mikrotik
    const authorized = await mikrotikService.authorizeUser(mac, ip, cpfClean, nome_completo);
    if (!authorized) {
      console.warn(`[Cadastro] Mikrotik não autorizou ${cpfClean}, mas cadastro foi salvo`);
    }

    console.log(`[Cadastro] Usuário cadastrado: ${cpfClean} - ${nome_completo}`);

    // Redireciona para sucesso
    const successUrl = `/success?nome=${encodeURIComponent(nome_completo)}&linkOrig=${encodeURIComponent(linkOrig || '')}`;
    res.redirect(successUrl);
  } catch (err) {
    console.error('[Cadastro] Erro:', err.message);
    res.render('portal', {
      mac: req.body.mac || '',
      ip: req.body.ip || '',
      username: '',
      linkOrig: req.body.linkOrig || '',
      error: 'Erro interno. Tente novamente.'
    });
  }
};

exports.login = async (req, res) => {
  try {
    const { cpf, mac, ip, linkOrig } = req.body;
    if (!cpf) {
      return res.render('portal', {
        mac, ip, username: '', linkOrig,
        error: 'CPF é obrigatório.'
      });
    }
    const cpfClean = cpf.replace(/\D/g, '');

    if (!validateCPF(cpfClean)) {
      return res.render('portal', {
        mac, ip, username: '', linkOrig,
        error: 'CPF inválido.'
      });
    }

    const user = await User.findOne({ where: { cpf: cpfClean } });
    if (!user) {
      return res.render('portal', {
        mac, ip, username: '', linkOrig,
        error: 'CPF não encontrado. Faça seu cadastro primeiro.'
      });
    }

    // Cria nova sessão (desativa anteriores expiradas)
    await sessionService.createSession(user.id, mac, ip);

    // Autoriza no Mikrotik
    const authorized = await mikrotikService.authorizeUser(mac, ip, cpfClean, user.nome_completo);
    if (!authorized) {
      console.warn(`[Login] Mikrotik não autorizou ${cpfClean}, mas login prosseguiu`);
    }

    console.log(`[Login] Usuário autenticado: ${cpfClean} - ${user.nome_completo}`);

    const successUrl = `/success?nome=${encodeURIComponent(user.nome_completo)}&linkOrig=${encodeURIComponent(linkOrig || '')}`;
    res.redirect(successUrl);
  } catch (err) {
    console.error('[Login] Erro:', err.message);
    res.render('portal', {
      mac: req.body.mac || '',
      ip: req.body.ip || '',
      username: '',
      linkOrig: req.body.linkOrig || '',
      error: 'Erro interno. Tente novamente.'
    });
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
