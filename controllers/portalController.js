const { Setting } = require('../models');
const { getOrgSettings } = require('../utils/orgSettings');
const logger = require('../utils/logger');

// Aceita apenas URLs http/https para evitar injeção via javascript: ou data:
function sanitizeRedirectUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? url : '';
  } catch {
    return '';
  }
}

exports.showPortal = async (req, res) => {
  const { mac, ip, username, 'link-orig': linkOrig } = req.query;
  try {
    const settings = await getOrgSettings();
    res.render('portal', {
      mac: mac || '',
      ip: ip || '',
      username: username || '',
      linkOrig: linkOrig || '',
      error: null,
      activeTab: 'cadastro',
      ...settings
    });
  } catch (err) {
    logger.error(`[Portal] Erro ao carregar página principal: ${err.message}`);
    res.status(500).send('Erro ao carregar o portal. Tente novamente.');
  }
};

exports.showSuccess = async (req, res) => {
  const { nome, linkOrig } = req.query;
  try {
    const settings = await getOrgSettings();
    const sessionDuration = await Setting.getSessionDuration();

    // Calcula a expiração da sessão para exibição dinâmica no template
    const expiresAt = new Date(Date.now() + sessionDuration * 60 * 60 * 1000);
    const expiresAtISO = expiresAt.toISOString();
    const expiresAtLabel = expiresAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    res.render('success', {
      nome: nome || 'Usuário',
      linkOrig: sanitizeRedirectUrl(linkOrig),
      sessionDuration,
      expiresAtISO,
      expiresAtLabel,
      ...settings
    });
  } catch (err) {
    logger.error(`[Portal] Erro ao carregar página de sucesso: ${err.message}`);
    res.status(500).send('Erro ao carregar a página. Tente novamente.');
  }
};
