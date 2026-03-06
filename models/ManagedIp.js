const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ManagedIp = sequelize.define('ManagedIp', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  ip_address: {
    type: DataTypes.STRING(45),
    allowNull: false,
    unique: true
  },
  mac_address: {
    type: DataTypes.STRING(17),
    allowNull: true
  },
  hostname: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  location: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  department: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  responsible: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false
  }
}, {
  tableName: 'managed_ips',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { unique: true, fields: ['ip_address'] },
    { fields: ['mac_address'] },
    { fields: ['is_active'] }
  ]
});

module.exports = ManagedIp;
