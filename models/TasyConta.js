const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const TasyConta = sequelize.define('TasyConta', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  nr_atendimento: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true,
    comment: 'Número do atendimento/conta no Tasy (chave natural)'
  },
  nm_paciente: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  ds_convenio: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Convênio / plano de saúde'
  },
  ds_setor: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Setor / ala / departamento'
  },
  ds_status_origem: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Valor bruto do status vindo do Oracle'
  },
  status_categoria: {
    type: DataTypes.ENUM('aberto', 'pendente', 'faturado', 'outro'),
    allowNull: false,
    defaultValue: 'outro',
    comment: 'Categoria calculada a partir de ds_status_origem'
  },
  vl_conta: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true,
    defaultValue: 0
  },
  dt_entrada: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  dt_saida: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  dt_faturamento: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  synced_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'tasy_contas',
  underscored: true,
  indexes: [
    { fields: ['status_categoria'] },
    { fields: ['ds_convenio'] },
    { fields: ['ds_setor'] },
    { fields: ['dt_entrada'] },
    { fields: ['synced_at'] }
  ]
});

module.exports = TasyConta;
