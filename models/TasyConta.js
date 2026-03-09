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
    comment: 'Número do atendimento/conta no Tasy (chave natural)'
  },
  nm_paciente: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  cd_pessoa_fisica: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'CPF do paciente'
  },
  ds_convenio: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Convênio / plano de saúde'
  },
  ds_plano: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Plano específico dentro do convênio'
  },
  ds_setor: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Setor / ala / departamento de atendimento'
  },
  ds_tipo_atendimento: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Tipo de atendimento (internação, ambulatorial, etc.)'
  },
  nm_medico: {
    type: DataTypes.STRING(150),
    allowNull: true,
    comment: 'Médico responsável'
  },
  ds_especialidade: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Especialidade médica'
  },
  ds_status_origem: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Valor bruto do status vindo do Oracle'
  },
  status_categoria: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'outro',
    comment: 'Categoria calculada (aberto|pendente|faturado|outro)'
  },
  ie_cancelamento: {
    type: DataTypes.STRING(5),
    allowNull: true,
    comment: 'Indicador de cancelamento do Oracle'
  },
  cd_autorizacao: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'Número de autorização TISS (CONTA_PACIENTE)'
  },
  nr_guia_prestador: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'Número da guia do prestador (CONTA_PACIENTE)'
  },
  nr_protocolo_conta: {
    type: DataTypes.STRING(40),
    allowNull: true,
    comment: 'Número do protocolo texto (CONTA_PACIENTE.NR_PROTOCOLO)'
  },
  qt_dias_conta: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Quantidade de dias da conta (CONTA_PACIENTE)'
  },
  ds_inconsistencia: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Inconsistência detectada (CONTA_PACIENTE)'
  },
  ie_tipo_atend_tiss: {
    type: DataTypes.STRING(2),
    allowNull: true,
    comment: 'Tipo de atendimento TISS: 01=Consulta, 02=Internação, 03=SPSADT, 04=Outros'
  },
  ie_status_protocolo: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Status do protocolo (1=Provisório,2=Definitivo,3=Auditoria,4=Perda,5=Cancelado)'
  },
  nr_seq_protocolo: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Número sequencial do protocolo convênio'
  },
  vl_conta: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true,
    defaultValue: 0,
    comment: 'Valor faturado (VL_FATURADO)'
  },
  vl_glosa: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true,
    defaultValue: 0,
    comment: 'Valor glosado pelo convênio'
  },
  pr_glosa: {
    type: DataTypes.DECIMAL(6, 2),
    allowNull: true,
    defaultValue: 0,
    comment: 'Percentual de glosa'
  },
  vl_liquido: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true,
    defaultValue: 0,
    comment: 'Valor líquido após glosa (VL_LIQUIDO)'
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
  dt_conta_definitiva: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    comment: 'Data de fechamento definitivo da conta (CONTA_PACIENTE)'
  },
  dt_conta_protocolo: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    comment: 'Data de entrada em protocolo convênio (CONTA_PACIENTE)'
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
    { unique: true, fields: ['nr_atendimento'] },
    { fields: ['status_categoria'] },
    { fields: ['ds_convenio'] },
    { fields: ['ds_setor'] },
    { fields: ['ds_tipo_atendimento'] },
    { fields: ['nm_medico'] },
    { fields: ['dt_entrada'] },
    { fields: ['synced_at'] }
  ]
});

module.exports = TasyConta;
