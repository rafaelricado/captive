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

// Modo thick: necessário para autenticação Oracle 10g (verifier SHA-1/0x939)
// Oracle Instant Client instalado em /opt/oracle/instantclient_21_10
oracledb.initOracleClient({ libDir: '/opt/oracle/instantclient_21_10' });

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
  nr_atendimento:      'NR_ATENDIMENTO',        // número do atendimento (chave única)
  nm_paciente:         'NM_PACIENTE',            // nome do paciente
  cd_pessoa_fisica:    'CD_PESSOA_FISICA',       // CPF
  ds_convenio:         'DS_CONVENIO',            // convênio / plano
  ds_plano:            'DS_PLANO',               // plano específico
  ds_setor:            'DS_SETOR_ATENDIMENTO',   // setor / ala
  ds_tipo_atendimento: 'DS_TIPO_ATENDIMENTO',    // tipo de atendimento
  nm_medico:           'NM_MEDICO',              // médico responsável
  ds_especialidade:    'DS_ESPECIALIDADE',       // especialidade médica
  ds_status_origem:    'DS_STATUS_ACERTO',       // status bruto (acerto/faturamento)
  ie_cancelamento:     'IE_CANCELAMENTO',        // indicador de cancelamento
  vl_conta:            'VL_FATURADO',            // valor faturado
  vl_glosa:            'VL_GLOSA',               // valor glosado
  pr_glosa:            'PR_GLOSA',               // percentual de glosa
  vl_liquido:          'VL_LIQUIDO',             // valor líquido (após glosa)
  dt_entrada:          'DT_ENTRADA',             // data de internação/entrada
  dt_saida:            'DT_ALTA',                // data de alta/saída
  dt_faturamento:      'DT_RECEITA',             // data de receita (faturamento)
  ie_status_protocolo: 'IE_STATUS_PROTOCOLO',   // status do protocolo (1-5)
  nr_seq_protocolo:    'NR_SEQ_PROTOCOLO',       // nº sequencial do protocolo
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
        WHERE TABLE_NAME = 'EIS_CONTA_PACIENTE_V2' AND OWNER = 'TASY'
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

  const BATCH = 500;
  let conn, resultSet;
  try {
    conn = await oracledb.getConnection(ORACLE_CONFIG);
    conn.callTimeout = 120000; // 2min por fetch

    const result = await conn.execute(
      `SELECT ${cols} FROM TASY.EIS_CONTA_PACIENTE_V2
        WHERE DT_ENTRADA >= ADD_MONTHS(SYSDATE, -3)
           OR DT_ENTRADA IS NULL`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT, resultSet: true, fetchArraySize: BATCH }
    );
    resultSet = result.resultSet;

    const now = new Date();
    let total = 0;
    let rawRows;

    // Processa em cursor — evita carregar toda a view na memória
    while ((rawRows = await resultSet.getRows(BATCH)).length > 0) {
      const batch = rawRows
        .map(r => ({
          nr_atendimento:      String(r[C.nr_atendimento] ?? '').trim(),
          nm_paciente:         r[C.nm_paciente]         ?? null,
          cd_pessoa_fisica:    r[C.cd_pessoa_fisica]    ? String(r[C.cd_pessoa_fisica]).replace(/\D/g, '').slice(0, 20) : null,
          ds_convenio:         r[C.ds_convenio]         ?? null,
          ds_plano:            r[C.ds_plano]            ?? null,
          ds_setor:            r[C.ds_setor]            ?? null,
          ds_tipo_atendimento: r[C.ds_tipo_atendimento] ?? null,
          nm_medico:           r[C.nm_medico]           ?? null,
          ds_especialidade:    r[C.ds_especialidade]    ?? null,
          ds_status_origem:    r[C.ds_status_origem]    ?? null,
          status_categoria:    categorizeStatus(r[C.ds_status_origem]),
          ie_cancelamento:     r[C.ie_cancelamento]     ?? null,
          vl_conta:            r[C.vl_conta]            ?? 0,
          vl_glosa:            r[C.vl_glosa]            ?? 0,
          pr_glosa:            r[C.pr_glosa]            ?? 0,
          vl_liquido:          r[C.vl_liquido]          ?? 0,
          dt_entrada:          oracleToDate(r[C.dt_entrada]),
          dt_saida:            oracleToDate(r[C.dt_saida]),
          dt_faturamento:      oracleToDate(r[C.dt_faturamento]),
          ie_status_protocolo: r[C.ie_status_protocolo] != null ? Number(r[C.ie_status_protocolo]) : null,
          nr_seq_protocolo:    r[C.nr_seq_protocolo]    != null ? Number(r[C.nr_seq_protocolo])    : null,
          synced_at:           now,
        }))
        .filter(r => r.nr_atendimento);

      // Deduplicar por nr_atendimento (a view pode ter linhas repetidas)
      const dedupMap = new Map();
      for (const row of batch) dedupMap.set(row.nr_atendimento, row);
      const deduped = Array.from(dedupMap.values());

      if (deduped.length > 0) {
        await TasyConta.bulkCreate(deduped, {
          conflictAttributes: ['nr_atendimento'],
          updateOnDuplicate: [
            'nm_paciente', 'cd_pessoa_fisica',
            'ds_convenio', 'ds_plano', 'ds_setor',
            'ds_tipo_atendimento', 'nm_medico', 'ds_especialidade',
            'ds_status_origem', 'status_categoria', 'ie_cancelamento',
            'vl_conta', 'vl_glosa', 'pr_glosa', 'vl_liquido',
            'dt_entrada', 'dt_saida', 'dt_faturamento',
            'ie_status_protocolo', 'nr_seq_protocolo', 'synced_at'
          ]
        });
        total += deduped.length;
        logger.info(`[Tasy] Progresso: ${total} contas...`);
        // Pausa entre lotes para reduzir impacto no Oracle
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (total === 0) {
      logger.warn('[Tasy] syncContas: view retornou 0 registros.');
      return 0;
    }

    logger.info(`[Tasy] Sync concluído: ${total} contas.`);
    return total;
  } finally {
    if (resultSet) await resultSet.close().catch(() => {});
    if (conn) await conn.close().catch(() => {});
  }
}

module.exports = { discoverColumns, syncContas };
