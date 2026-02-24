const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AccessPoint = sequelize.define('AccessPoint', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
    validate: { notEmpty: true, len: [1, 100] }
  },
  ip_address: {
    type: DataTypes.STRING(45), // suporta IPv4 e IPv6
    allowNull: false,
    validate: { notEmpty: true }
  },
  location: {
    type: DataTypes.STRING(200),
    allowNull: true
  },
  is_online: {
    type: DataTypes.BOOLEAN,
    allowNull: true,  // null = nunca verificado
    defaultValue: null
  },
  latency_ms: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  last_checked_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true // false = pausar monitoramento sem excluir
  }
}, {
  tableName: 'access_points',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = AccessPoint;
