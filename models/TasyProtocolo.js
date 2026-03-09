const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const TasyProtocolo = sequelize.define('TasyProtocolo', {
  id: {
    type:         DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey:   true,
  },
  nr_protocolo: {
    type:      DataTypes.STRING(50),
    allowNull: false,
  },
  ds_convenio: {
    type:      DataTypes.STRING(255),
    allowNull: false,
  },
  dt_inicio: {
    type:      DataTypes.DATEONLY,
    allowNull: true,
  },
  dt_fim: {
    type:      DataTypes.DATEONLY,
    allowNull: true,
  },
  qt_contas: {
    type:         DataTypes.INTEGER,
    defaultValue: 0,
  },
  vl_total: {
    type:         DataTypes.DECIMAL(14, 2),
    defaultValue: 0,
  },
  // rascunho → enviado → faturado → pago (ou cancelado)
  status: {
    type:         DataTypes.STRING(20),
    allowNull:    false,
    defaultValue: 'rascunho',
  },
  nr_nota_fiscal: {
    type:      DataTypes.STRING(50),
    allowNull: true,
  },
  dt_emissao: {
    type:      DataTypes.DATEONLY,
    allowNull: false,
  },
  dt_envio: {
    type:      DataTypes.DATEONLY,
    allowNull: true,
  },
  dt_faturamento: {
    type:      DataTypes.DATEONLY,
    allowNull: true,
  },
  dt_pagamento: {
    type:      DataTypes.DATEONLY,
    allowNull: true,
  },
  obs: {
    type:      DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'tasy_protocolos',
  indexes: [
    { fields: ['ds_convenio'] },
    { fields: ['status'] },
    { fields: ['dt_emissao'] },
  ],
});

module.exports = TasyProtocolo;
