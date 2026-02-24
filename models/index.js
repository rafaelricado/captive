const sequelize = require('../config/database');
const User = require('./User');
const Session = require('./Session');
const Setting = require('./Setting');
const AccessPoint = require('./AccessPoint');
const ApPingHistory = require('./ApPingHistory');

// Associação: histórico pertence ao ponto de acesso
ApPingHistory.belongsTo(AccessPoint, { foreignKey: 'ap_id', as: 'AccessPoint' });
AccessPoint.hasMany(ApPingHistory, { foreignKey: 'ap_id', as: 'PingHistory' });

const initDatabase = async () => {
  await sequelize.sync({ alter: true });

  const [sessionSetting] = await Setting.findOrCreate({
    where: { key: 'session_duration_hours' },
    defaults: { value: process.env.SESSION_DURATION_HOURS || '48' }
  });

  await Setting.findOrCreate({
    where: { key: 'organization_name' },
    defaults: { value: 'Captive Portal' }
  });

  await Setting.findOrCreate({
    where: { key: 'organization_logo' },
    defaults: { value: '' }
  });

  await Setting.findOrCreate({
    where: { key: 'portal_bg_color_1' },
    defaults: { value: '#0d4e8b' }
  });

  await Setting.findOrCreate({
    where: { key: 'portal_bg_color_2' },
    defaults: { value: '#1a7bc4' }
  });

  // Webhook para alertas de AP offline (vazio = desabilitado)
  await Setting.findOrCreate({
    where: { key: 'alert_webhook_url' },
    defaults: { value: '' }
  });

  const logger = require('../utils/logger');
  logger.info(`[DB] Banco sincronizado. Duração da sessão: ${sessionSetting.value}h`);
};

module.exports = { sequelize, User, Session, Setting, AccessPoint, ApPingHistory, initDatabase };
