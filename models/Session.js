const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const User = require('./User');

const Session = sequelize.define('Session', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: User,
      key: 'id'
    }
  },
  mac_address: {
    type: DataTypes.STRING
  },
  ip_address: {
    type: DataTypes.STRING
  },
  started_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false
  },
  active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  tableName: 'sessions',
  timestamps: false,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['expires_at'] },
    { fields: ['active', 'expires_at'] }
  ]
});

Session.belongsTo(User, { foreignKey: 'user_id', onDelete: 'CASCADE', onUpdate: 'CASCADE' });
User.hasMany(Session, { foreignKey: 'user_id', onDelete: 'CASCADE', onUpdate: 'CASCADE' });

module.exports = Session;
