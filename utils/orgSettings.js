/**
 * Helper compartilhado para buscar as configurações de marca do portal.
 * Evita duplicação entre portalController, apiController e routes/api.js.
 */
const { Setting } = require('../models');
const cache = require('./settingsCache');

const CACHE_KEY = 'org_settings';

async function getOrgSettings() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

  const [orgName, orgLogo, bgColor1, bgColor2] = await Promise.all([
    Setting.get('organization_name', 'Captive Portal'),
    Setting.get('organization_logo', ''),
    Setting.get('portal_bg_color_1', '#0d4e8b'),
    Setting.get('portal_bg_color_2', '#1a7bc4')
  ]);

  const result = { orgName, orgLogo, bgColor1, bgColor2 };
  cache.set(CACHE_KEY, result);
  return result;
}

module.exports = { getOrgSettings };
