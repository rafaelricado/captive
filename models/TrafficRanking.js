const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const TrafficRanking = sequelize.define('TrafficRanking', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  ip_address: {
    type: DataTypes.STRING(45),
    allowNull: false
  },
  hostname: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  mac_address: {
    type: DataTypes.STRING(17),
    allowNull: true
  },
  bytes_up: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0
  },
  bytes_down: {
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
  tableName: 'traffic_rankings',
  timestamps: false,
  indexes: [
    { fields: ['ip_address', 'recorded_at'] },
    { fields: ['recorded_at'] }
  ]
});

module.exports = TrafficRanking;
