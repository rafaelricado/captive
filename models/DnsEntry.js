const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const DnsEntry = sequelize.define('DnsEntry', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  domain: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  ip_address: {
    type: DataTypes.STRING(45),
    allowNull: true
  },
  router_name: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  recorded_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'dns_entries',
  timestamps: false,
  indexes: [
    { fields: ['domain'] }
  ]
});

module.exports = DnsEntry;
