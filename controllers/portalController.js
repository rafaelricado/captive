const { Setting } = require('../models');

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

async function getPortalSettings() {
  const [orgName, orgLogo, bgColor1, bgColor2] = await Promise.all([
    Setting.get('organization_name', 'Hospital Beneficiente Portuguesa'),
    Setting.get('organization_logo', ''),
    Setting.get('portal_bg_color_1', '#0d4e8b'),
    Setting.get('portal_bg_color_2', '#1a7bc4')
  ]);
  return { orgName, orgLogo, bgColor1, bgColor2 };
}

exports.showPortal = async (req, res) => {
  const { mac, ip, username, 'link-orig': linkOrig } = req.query;
  const settings = await getPortalSettings();

  res.render('portal', {
    mac: mac || '',
    ip: ip || '',
    username: username || '',
    linkOrig: linkOrig || '',
    error: null,
    activeTab: 'cadastro',
    ...settings
  });
};

exports.showSuccess = async (req, res) => {
  const { nome, linkOrig } = req.query;
  const settings = await getPortalSettings();

  res.render('success', {
    nome: nome || 'Usuário',
    linkOrig: sanitizeRedirectUrl(linkOrig),
    ...settings
  });
};
