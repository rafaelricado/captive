const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const cache = require('../utils/settingsCache');

const SETTING_CACHE_TTL = 60 * 1000; // 1 minuto

const Setting = sequelize.define('Setting', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  key: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  value: {
    type: DataTypes.STRING(1024),
    allowNull: false
  }
}, {
  tableName: 'settings',
  timestamps: false
});

Setting.get = async function (key, defaultValue = null) {
  const cacheKey = `setting:${key}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const s = await Setting.findOne({ where: { key } });
  const value = s ? s.value : defaultValue;
  cache.set(cacheKey, value, SETTING_CACHE_TTL);
  return value;
};

Setting.set = async function (key, value) {
  const [s] = await Setting.findOrCreate({ where: { key }, defaults: { value: String(value) } });
  if (s.value !== String(value)) {
    s.value = String(value);
    await s.save();
  }
  // Invalida cache desta chave e o cache agregado de org_settings
  cache.invalidate(`setting:${key}`);
  cache.invalidate('org_settings');
  return s;
};

Setting.getSessionDuration = async function () {
  const val = await Setting.get('session_duration_hours', '48');
  const hours = parseInt(val, 10);
  return (isNaN(hours) || hours < 1 || hours > 720) ? 48 : hours;
};

module.exports = Setting;
