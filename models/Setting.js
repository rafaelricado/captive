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
    type: DataTypes.STRING,
    allowNull: false
  }
}, {
  tableName: 'settings',
  timestamps: false
});

Setting.getSessionDuration = async function () {
  const setting = await Setting.findOne({ where: { key: 'session_duration_hours' } });
  return setting ? parseInt(setting.value, 10) : 48;
};

module.exports = Setting;
