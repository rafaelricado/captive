/**
 * tasyService.js
 * Sincroniza dados da view EIS_CONTA_PACIENTE_V2 (Oracle) para o PostgreSQL local.
 *
 * MAPEAMENTO DE COLUNAS:
 * Ajuste ORACLE_COL_MAP e STATUS_MAP após rodar discoverColumns() para ver
 * os nomes reais das colunas da view no seu ambiente.
 */

const oracledb = require('oracledb');
const { TasyConta } = require('../models');
const logger = require('../utils/logger');

// Modo thin: não requer Oracle Instant Client instalado
oracledb.initOracleClient = undefined; // garante thin mode (padrão no oracledb 6+)

const ORACLE_CONFIG = {
  user:             process.env.TASY_USER,
  password:         process.env.TASY_PASS,
  connectString:    `${process.env.TASY_HOST || '192.168.0.201'}:${process.env.TASY_PORT || 1521}/${process.env.TASY_SERVICE || 'dbprod'}`,
};

// -------------------------------------------------
// Mapeamento: coluna Oracle → campo local
// ATENÇÃO: ajuste os nomes das colunas Oracle após
// rodar discoverColumns() e ver o resultado nos logs.
// -------------------------------------------------
const ORACLE_COL_MAP = {
  nr_atendimento:   'NR_ATENDIMENTO',   // número do atendimento (chave única)
  nm_paciente:      'NM_PACIENTE',       // nome do paciente
  ds_convenio:      'DS_CONVENIO',       // convênio / plano
  ds_setor:         'DS_SETOR',          // setor / ala
  ds_status_origem: 'DS_STATUS',         // status bruto
  vl_conta:         'VL_CONTA',          // valor total da conta
  dt_entrada:       'DT_ENTRADA',        // data de internação/entrada
  dt_saida:         'DT_SAIDA',          // data de alta/saída
  dt_faturamento:   'DT_FATURAMENTO',    // data de faturamento
};

// -------------------------------------------------
// STATUS_MAP: quais valores brutos do Oracle
// correspondem a cada categoria.
// Valores em MAIÚSCULAS (a comparação é case-insensitive).
// Ajuste após ver os valores reais com discoverColumns().
// -------------------------------------------------
const STATUS_MAP = {
  aberto:   ['A', '1', 'ABERTO', 'EM ABERTO', 'ABERTA'],
  pendente: ['P', '2', 'PENDENTE', 'PEND', 'PEND FATURAMENTO', 'AGUARDANDO FATURAMENTO'],
  faturado: ['F', '3', 'FATURADO', 'FATURADA', 'FATURAMENTO CONCLUIDO', 'CONCLUIDO'],
};

function categorizeStatus(rawStatus) {
  if (!rawStatus) return 'outro';
  const upper = String(rawStatus).trim().toUpperCase();
  for (const [cat, values] of Object.entries(STATUS_MAP)) {
    if (values.includes(upper)) return cat;
  }
  return 'outro';
}

function oracleToDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return null;
}

/**
 * Lista as colunas da view EIS_CONTA_PACIENTE_V2.
 * Útil para mapear ORACLE_COL_MAP na primeira configuração.
 * Os nomes são logados como INFO no startup.
 */
async function discoverColumns() {
  if (!ORACLE_CONFIG.user) {
    logger.warn('[Tasy] TASY_USER não configurado — discoverColumns ignorado.');
    return;
  }
  let conn;
  try {
    conn = await oracledb.getConnection(ORACLE_CONFIG);
    const result = await conn.execute(
      `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH
         FROM ALL_TAB_COLUMNS
        WHERE TABLE_NAME = 'EIS_CONTA_PACIENTE_V2'
        ORDER BY COLUMN_ID`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    if (result.rows.length === 0) {
      logger.warn('[Tasy] View EIS_CONTA_PACIENTE_V2 não encontrada ou sem colunas visíveis para este usuário.');
      return;
    }
    const cols = result.rows.map(r => `${r.COLUMN_NAME} (${r.DATA_TYPE}${r.DATA_LENGTH ? `(${r.DATA_LENGTH})` : ''})`);
    logger.info('[Tasy] Colunas de EIS_CONTA_PACIENTE_V2:\n  ' + cols.join('\n  '));
  } catch (err) {
    logger.warn(`[Tasy] discoverColumns falhou: ${err.message}`);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/**
 * Sincroniza EIS_CONTA_PACIENTE_V2 → tasy_contas (PostgreSQL).
 * Usa upsert por nr_atendimento para preservar dados se Oracle estiver indisponível.
 * @returns {number} quantidade de registros sincronizados
 */
async function syncContas() {
  if (!ORACLE_CONFIG.user) {
    logger.warn('[Tasy] TASY_USER não configurado — sync ignorado.');
    return 0;
  }

  const C = ORACLE_COL_MAP;
  const cols = Object.values(C).join(', ');

  let conn;
  try {
    conn = await oracledb.getConnection(ORACLE_CONFIG);
    conn.callTimeout = 60000; // 60s timeout por chamada

    const result = await conn.execute(
      `SELECT ${cols} FROM EIS_CONTA_PACIENTE_V2`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchArraySize: 500 }
    );

    const now = new Date();
    const rows = result.rows.map(r => ({
      nr_atendimento:   String(r[C.nr_atendimento] ?? '').trim(),
      nm_paciente:      r[C.nm_paciente]      ?? null,
      ds_convenio:      r[C.ds_convenio]      ?? null,
      ds_setor:         r[C.ds_setor]         ?? null,
      ds_status_origem: r[C.ds_status_origem] ?? null,
      status_categoria: categorizeStatus(r[C.ds_status_origem]),
      vl_conta:         r[C.vl_conta]         ?? 0,
      dt_entrada:       oracleToDate(r[C.dt_entrada]),
      dt_saida:         oracleToDate(r[C.dt_saida]),
      dt_faturamento:   oracleToDate(r[C.dt_faturamento]),
      synced_at:        now,
    })).filter(r => r.nr_atendimento); // descarta linhas sem chave

    if (rows.length === 0) {
      logger.warn('[Tasy] syncContas: view retornou 0 registros.');
      return 0;
    }

    // Upsert em lotes de 500
    const BATCH = 500;
    let total = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      await TasyConta.bulkCreate(batch, {
        conflictAttributes: ['nr_atendimento'],
        updateOnDuplicate: [
          'nm_paciente', 'ds_convenio', 'ds_setor',
          'ds_status_origem', 'status_categoria',
          'vl_conta', 'dt_entrada', 'dt_saida', 'dt_faturamento', 'synced_at'
        ]
      });
      total += batch.length;
    }

    logger.info(`[Tasy] Sync concluído: ${total} contas.`);
    return total;
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

module.exports = { discoverColumns, syncContas };
