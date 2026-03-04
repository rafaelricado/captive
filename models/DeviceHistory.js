const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DeviceHistory = sequelize.define('DeviceHistory', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  mac_address: {
    type: DataTypes.STRING(17),
    allowNull: false
  },
  ip_address: {
    type: DataTypes.STRING(45),
    allowNull: false
  },
  hostname: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  router_name: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  first_seen: {
    type: DataTypes.DATE,
    allowNull: false
  },
  last_seen: {
    type: DataTypes.DATE,
    allowNull: false
  }
}, {
  tableName: 'device_history',
  timestamps: false,
  indexes: [
    {
      unique: true,
      fields: ['mac_address', 'ip_address', 'router_name'],
      name: 'device_history_mac_ip_router_unique'
    },
    { fields: ['mac_address'] },
    { fields: ['last_seen'] }
  ]
});

module.exports = DeviceHistory;
