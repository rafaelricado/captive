const sequelize = require('../config/database');
const User = require('./User');
const Session = require('./Session');
const Setting = require('./Setting');

const initDatabase = async () => {
  await sequelize.sync();

  const [setting] = await Setting.findOrCreate({
    where: { key: 'session_duration_hours' },
    defaults: { value: process.env.SESSION_DURATION_HOURS || '48' }
  });

  console.log(`[DB] Banco sincronizado. Duração da sessão: ${setting.value}h`);
};

module.exports = { sequelize, User, Session, Setting, initDatabase };
