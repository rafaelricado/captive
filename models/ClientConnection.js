const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ClientConnection = sequelize.define('ClientConnection', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  src_ip: {
    type: DataTypes.STRING(45),
    allowNull: false
  },
  dst_ip: {
    type: DataTypes.STRING(45),
    allowNull: false
  },
  dst_port: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  bytes_orig: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0
  },
  bytes_reply: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0
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
  tableName: 'client_connections',
  timestamps: false
});

module.exports = ClientConnection;
