/**
 * Helper compartilhado para buscar as configurações de marca do portal.
 * Evita duplicação entre portalController, apiController e routes/api.js.
 */
const { Setting } = require('../models');
const cache = require('./settingsCache');

const CACHE_KEY = 'org_settings';
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function safeColor(val, fallback) {
  return HEX_COLOR_RE.test(val) ? val : fallback;
}

async function getOrgSettings() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

  const [orgName, orgLogo, bgColor1Raw, bgColor2Raw] = await Promise.all([
    Setting.get('organization_name', 'Captive Portal'),
    Setting.get('organization_logo', ''),
    Setting.get('portal_bg_color_1', '#0d4e8b'),
    Setting.get('portal_bg_color_2', '#1a7bc4')
  ]);

  const bgColor1 = safeColor(bgColor1Raw, '#0d4e8b');
  const bgColor2 = safeColor(bgColor2Raw, '#1a7bc4');

  const result = { orgName, orgLogo, bgColor1, bgColor2 };
  cache.set(CACHE_KEY, result);
  return result;
}

module.exports = { getOrgSettings };
