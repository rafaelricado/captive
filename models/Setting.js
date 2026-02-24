const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

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
  const s = await Setting.findOne({ where: { key } });
  return s ? s.value : defaultValue;
};

Setting.set = async function (key, value) {
  const [s] = await Setting.findOrCreate({ where: { key }, defaults: { value: String(value) } });
  if (s.value !== String(value)) {
    s.value = String(value);
    await s.save();
  }
  return s;
};

Setting.getSessionDuration = async function () {
  const val = await Setting.get('session_duration_hours', '48');
  const hours = parseInt(val, 10);
  return (isNaN(hours) || hours < 1 || hours > 720) ? 48 : hours;
};

module.exports = Setting;
