const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * Histórico de pings de cada ponto de acesso.
 * Mantém até MAX_HISTORY_PER_AP registros por AP (limpeza automática após cada ciclo).
 */
const ApPingHistory = sequelize.define('ApPingHistory', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  ap_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  is_online: {
    type: DataTypes.BOOLEAN,
    allowNull: false
  },
  latency_ms: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  checked_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'ap_ping_history',
  timestamps: false,
  indexes: [
    { fields: ['ap_id', 'checked_at'] }
  ]
});

ApPingHistory.MAX_PER_AP = 200; // manter os últimos 200 registros por AP

module.exports = ApPingHistory;
