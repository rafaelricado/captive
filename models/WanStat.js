const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WanStat = sequelize.define('WanStat', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  interface_name: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  tx_bytes: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0
  },
  rx_bytes: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0
  },
  is_up: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
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
  tableName: 'wan_stats',
  timestamps: false,
  indexes: [
    { fields: ['interface_name', 'recorded_at'] },
    { fields: ['recorded_at'] }
  ]
});

module.exports = WanStat;
