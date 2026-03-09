const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const TasyProtocolo = sequelize.define('TasyProtocolo', {
  id: {
    type:         DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey:   true,
  },
  // Chave natural Oracle — unique nullable (NULLs não conflitam)
  nr_seq_protocolo: {
    type:      DataTypes.INTEGER,
    allowNull: true,
    comment:   'NR_SEQ_PROTOCOLO do Oracle (chave natural)',
  },
  nr_protocolo: {
    type:      DataTypes.STRING(40),
    allowNull: true,
    comment:   'Nome/número do protocolo (NR_PROTOCOLO)',
  },
  cd_convenio: {
    type:      DataTypes.INTEGER,
    allowNull: true,
    comment:   'Código do convênio (CD_CONVENIO)',
  },
  ie_status_protocolo: {
    type:      DataTypes.INTEGER,
    allowNull: true,
    comment:   '1=Provisório 2=Definitivo 3=Auditoria 4=Perda 5=Cancelado',
  },
  ie_tipo_protocolo: {
    type:      DataTypes.INTEGER,
    allowNull: true,
    comment:   'Tipo do protocolo (IE_TIPO_PROTOCOLO)',
  },
  dt_periodo_inicial: {
    type:      DataTypes.DATEONLY,
    allowNull: true,
  },
  dt_periodo_final: {
    type:      DataTypes.DATEONLY,
    allowNull: true,
  },
  dt_geracao: {
    type:      DataTypes.DATE,
    allowNull: true,
    comment:   'Data de geração do protocolo',
  },
  dt_envio: {
    type:      DataTypes.DATE,
    allowNull: true,
    comment:   'Data de envio ao convênio',
  },
  dt_retorno: {
    type:      DataTypes.DATE,
    allowNull: true,
    comment:   'Data de retorno do convênio',
  },
  dt_definitivo: {
    type:      DataTypes.DATE,
    allowNull: true,
    comment:   'Data de fechamento definitivo',
  },
  dt_vencimento: {
    type:      DataTypes.DATEONLY,
    allowNull: true,
    comment:   'Data de vencimento do protocolo',
  },
  dt_entrega_convenio: {
    type:      DataTypes.DATEONLY,
    allowNull: true,
    comment:   'Data de entrega física ao convênio',
  },
  vl_recebimento: {
    type:         DataTypes.DECIMAL(14, 2),
    allowNull:    true,
    defaultValue: 0,
    comment:      'Valor recebido do convênio',
  },
  ds_inconsistencia: {
    type:      DataTypes.STRING(80),
    allowNull: true,
  },
  ds_observacao: {
    type:      DataTypes.STRING(800),
    allowNull: true,
  },
  nm_usuario: {
    type:      DataTypes.STRING(15),
    allowNull: true,
    comment:   'Usuário responsável no Oracle',
  },
  synced_at: {
    type:         DataTypes.DATE,
    allowNull:    false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'tasy_protocolos',
  underscored: true,
  indexes: [
    // PostgreSQL permite múltiplos NULLs em índice único — registros legados sem nr_seq_protocolo não conflitam
    { unique: true, fields: ['nr_seq_protocolo'] },
    { fields: ['ie_status_protocolo'] },
    { fields: ['cd_convenio'] },
    { fields: ['dt_periodo_inicial'] },
    { fields: ['synced_at'] },
  ],
});

module.exports = TasyProtocolo;
