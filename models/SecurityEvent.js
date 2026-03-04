const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SecurityEvent = sequelize.define('SecurityEvent', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  event_type: {
    type: DataTypes.ENUM('brute_force', 'port_scan', 'traffic_anomaly'),
    allowNull: false
  },
  severity: {
    type: DataTypes.ENUM('low', 'medium', 'high'),
    allowNull: false
  },
  src_ip: {
    type: DataTypes.STRING(45),
    allowNull: false
  },
  details: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: {}
  },
  acknowledged: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  detected_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'security_events',
  timestamps: false,
  indexes: [
    { fields: ['event_type', 'src_ip', 'detected_at'] },
    { fields: ['acknowledged', 'detected_at'] },
    { fields: ['detected_at'] }
  ]
});

module.exports = SecurityEvent;
