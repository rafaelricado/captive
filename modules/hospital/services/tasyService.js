/**
 * tasyService.js
 * Sincroniza dados da view EIS_CONTA_PACIENTE_V2 (Oracle) para o PostgreSQL local.
 *
 * MAPEAMENTO DE COLUNAS:
 * Ajuste ORACLE_COL_MAP e STATUS_MAP após rodar discoverColumns() para ver
 * os nomes reais das colunas da view no seu ambiente.
 */

const oracledb = require('oracledb');
const { TasyConta, TasyProtocolo } = require('../../../models');
const logger = require('../../../utils/logger');

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

// Categorização baseada em DT_CONTA_DEFINITIVA (CONTA_PACIENTE):
//   - NULL  → aberto (conta ainda não fechada/faturada)
//   - preenchida → faturado (conta definitivamente fechada)
// ie_cancelamento preenchido → cancelado (tratado separadamente na view)
function categorizeStatus(dtContaDefinitiva, ieCancelamento) {
  if (ieCancelamento) return 'outro';
  if (dtContaDefinitiva) return 'faturado';
  return 'aberto';
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
async function syncContas(onProgress) {
  if (!ORACLE_CONFIG.user) {
    logger.warn('[Tasy] TASY_USER não configurado — sync ignorado.');
    return 0;
  }

  const C = ORACLE_COL_MAP;
  const viewCols = Object.values(C).map(col => `V.${col}`).join(', ');

  const BATCH = 500;
  let conn, resultSet;
  try {
    conn = await oracledb.getConnection(ORACLE_CONFIG);
    conn.callTimeout = 120000;

    // Total para cálculo de progresso
    let totalOracle = 0;
    if (onProgress) {
      const countRes = await conn.execute(
        `SELECT COUNT(*) FROM TASY.EIS_CONTA_PACIENTE_V2 V
          LEFT JOIN TASY.CONTA_PACIENTE CP ON CP.NR_ATENDIMENTO = V.NR_ATENDIMENTO
          LEFT JOIN TASY.ATENDIMENTO_PACIENTE AP ON AP.NR_ATENDIMENTO = V.NR_ATENDIMENTO
         WHERE V.DT_ENTRADA >= ADD_MONTHS(SYSDATE, -6) OR V.DT_ENTRADA IS NULL`,
        [], { outFormat: oracledb.OUT_FORMAT_ARRAY }
      );
      totalOracle = countRes.rows[0][0];
      onProgress({ processed: 0, total: totalOracle, pct: 0 });
    }

    const result = await conn.execute(
      `SELECT ${viewCols},
              CP.DT_CONTA_DEFINITIVA,
              CP.DT_CONTA_PROTOCOLO,
              CP.CD_AUTORIZACAO,
              CP.NR_GUIA_PRESTADOR,
              CP.NR_PROTOCOLO       AS NR_PROTOCOLO_CONTA,
              CP.QT_DIAS_CONTA,
              CP.DS_INCONSISTENCIA,
              AP.IE_TIPO_ATEND_TISS
         FROM TASY.EIS_CONTA_PACIENTE_V2 V
         LEFT JOIN TASY.CONTA_PACIENTE CP ON CP.NR_ATENDIMENTO = V.NR_ATENDIMENTO
         LEFT JOIN TASY.ATENDIMENTO_PACIENTE AP ON AP.NR_ATENDIMENTO = V.NR_ATENDIMENTO
        WHERE V.DT_ENTRADA >= ADD_MONTHS(SYSDATE, -6)
           OR V.DT_ENTRADA IS NULL`,
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
          status_categoria:    categorizeStatus(r['DT_CONTA_DEFINITIVA'], r[C.ie_cancelamento]),
          ie_cancelamento:     r[C.ie_cancelamento]     ?? null,
          cd_autorizacao:      r['CD_AUTORIZACAO']      ? String(r['CD_AUTORIZACAO']).trim() : null,
          nr_guia_prestador:   r['NR_GUIA_PRESTADOR']   ? String(r['NR_GUIA_PRESTADOR']).trim() : null,
          nr_protocolo_conta:  r['NR_PROTOCOLO_CONTA']  ? String(r['NR_PROTOCOLO_CONTA']).trim() : null,
          qt_dias_conta:       r['QT_DIAS_CONTA']       != null ? Number(r['QT_DIAS_CONTA']) : null,
          ds_inconsistencia:   r['DS_INCONSISTENCIA']   ?? null,
          ie_tipo_atend_tiss:  r['IE_TIPO_ATEND_TISS']  ? String(r['IE_TIPO_ATEND_TISS']).trim() : null,
          dt_conta_definitiva: oracleToDate(r['DT_CONTA_DEFINITIVA']),
          dt_conta_protocolo:  oracleToDate(r['DT_CONTA_PROTOCOLO']),
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
            'cd_autorizacao', 'nr_guia_prestador', 'nr_protocolo_conta',
            'qt_dias_conta', 'ds_inconsistencia', 'ie_tipo_atend_tiss',
            'ie_status_protocolo', 'nr_seq_protocolo',
            'dt_conta_definitiva', 'dt_conta_protocolo', 'synced_at'
          ]
        });
        total += deduped.length;
        logger.info(`[Tasy] Progresso: ${total} contas...`);
        if (onProgress) {
          const pct = totalOracle > 0 ? Math.min(99, Math.round(total / totalOracle * 100)) : null;
          onProgress({ processed: total, total: totalOracle, pct });
        }
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

/**
 * Sincroniza TASY.PROTOCOLO_CONVENIO → tasy_protocolos (PostgreSQL).
 * Upsert por NR_SEQ_PROTOCOLO.
 * @returns {number} quantidade de registros sincronizados
 */
async function syncProtocolos(onProgress) {
  if (!ORACLE_CONFIG.user) {
    logger.warn('[Tasy] TASY_USER não configurado — syncProtocolos ignorado.');
    return 0;
  }

  const BATCH = 500;
  let conn, resultSet;
  try {
    conn = await oracledb.getConnection(ORACLE_CONFIG);
    conn.callTimeout = 120000;

    // Total para cálculo de progresso
    let totalOracle = 0;
    if (onProgress) {
      const countRes = await conn.execute(
        `SELECT COUNT(*) FROM TASY.PROTOCOLO_CONVENIO P
         WHERE P.DT_PERIODO_INICIAL >= ADD_MONTHS(SYSDATE, -24) OR P.DT_PERIODO_INICIAL IS NULL`,
        [], { outFormat: oracledb.OUT_FORMAT_ARRAY }
      );
      totalOracle = countRes.rows[0][0];
      onProgress({ processed: 0, total: totalOracle, pct: 0 });
    }

    const result = await conn.execute(
      `SELECT P.NR_SEQ_PROTOCOLO,
              P.NR_PROTOCOLO,
              P.CD_CONVENIO,
              C.DS_CONVENIO AS DS_NOME_CONVENIO,
              P.IE_STATUS_PROTOCOLO,
              P.IE_TIPO_PROTOCOLO,
              P.DT_PERIODO_INICIAL,
              P.DT_PERIODO_FINAL,
              P.DT_GERACAO,
              P.DT_ENVIO,
              P.DT_RETORNO,
              P.DT_DEFINITIVO,
              P.DT_VENCIMENTO,
              P.DT_ENTREGA_CONVENIO,
              P.VL_RECEBIMENTO,
              P.DS_INCONSISTENCIA,
              P.DS_OBSERVACAO,
              P.NM_USUARIO
         FROM TASY.PROTOCOLO_CONVENIO P
         LEFT JOIN TASY.CONVENIO C ON C.CD_CONVENIO = P.CD_CONVENIO
        WHERE P.DT_PERIODO_INICIAL >= ADD_MONTHS(SYSDATE, -24)
           OR P.DT_PERIODO_INICIAL IS NULL
        ORDER BY P.NR_SEQ_PROTOCOLO`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT, resultSet: true, fetchArraySize: BATCH }
    );
    resultSet = result.resultSet;

    const now = new Date();
    let total = 0;
    let rawRows;

    while ((rawRows = await resultSet.getRows(BATCH)).length > 0) {
      const batch = rawRows
        .filter(r => r.NR_SEQ_PROTOCOLO != null)
        .map(r => ({
          nr_seq_protocolo:    Number(r.NR_SEQ_PROTOCOLO),
          nr_protocolo:        r.NR_PROTOCOLO        ? String(r.NR_PROTOCOLO).trim() : null,
          cd_convenio:         r.CD_CONVENIO         != null ? Number(r.CD_CONVENIO)         : null,
          ds_nome_convenio:    r.DS_NOME_CONVENIO    ? String(r.DS_NOME_CONVENIO).trim() : null,
          ie_status_protocolo: r.IE_STATUS_PROTOCOLO != null ? Number(r.IE_STATUS_PROTOCOLO) : null,
          ie_tipo_protocolo:   r.IE_TIPO_PROTOCOLO   != null ? Number(r.IE_TIPO_PROTOCOLO)   : null,
          dt_periodo_inicial:  oracleToDate(r.DT_PERIODO_INICIAL),
          dt_periodo_final:    oracleToDate(r.DT_PERIODO_FINAL),
          dt_geracao:          r.DT_GERACAO          instanceof Date ? r.DT_GERACAO          : null,
          dt_envio:            r.DT_ENVIO            instanceof Date ? r.DT_ENVIO            : null,
          dt_retorno:          r.DT_RETORNO          instanceof Date ? r.DT_RETORNO          : null,
          dt_definitivo:       r.DT_DEFINITIVO       instanceof Date ? r.DT_DEFINITIVO       : null,
          dt_vencimento:       oracleToDate(r.DT_VENCIMENTO),
          dt_entrega_convenio: oracleToDate(r.DT_ENTREGA_CONVENIO),
          vl_recebimento:      r.VL_RECEBIMENTO      ?? 0,
          ds_inconsistencia:   r.DS_INCONSISTENCIA   ?? null,
          ds_observacao:       r.DS_OBSERVACAO        ?? null,
          nm_usuario:          r.NM_USUARIO          ? String(r.NM_USUARIO).trim() : null,
          synced_at:           now,
        }));

      // Deduplicar por nr_seq_protocolo
      const dedupMap = new Map();
      for (const row of batch) dedupMap.set(row.nr_seq_protocolo, row);
      const deduped = Array.from(dedupMap.values());

      if (deduped.length > 0) {
        await TasyProtocolo.bulkCreate(deduped, {
          conflictAttributes: ['nr_seq_protocolo'],
          updateOnDuplicate: [
            'nr_protocolo', 'cd_convenio', 'ds_nome_convenio', 'ie_status_protocolo', 'ie_tipo_protocolo',
            'dt_periodo_inicial', 'dt_periodo_final',
            'dt_geracao', 'dt_envio', 'dt_retorno', 'dt_definitivo',
            'dt_vencimento', 'dt_entrega_convenio',
            'vl_recebimento', 'ds_inconsistencia', 'ds_observacao',
            'nm_usuario', 'synced_at',
          ],
        });
        total += deduped.length;
        logger.info(`[Tasy] Protocolos: ${total} sincronizados...`);
        if (onProgress) {
          const pct = totalOracle > 0 ? Math.min(99, Math.round(total / totalOracle * 100)) : null;
          onProgress({ processed: total, total: totalOracle, pct });
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }

    logger.info(`[Tasy] syncProtocolos concluído: ${total} protocolos.`);
    return total;
  } finally {
    if (resultSet) await resultSet.close().catch(() => {});
    if (conn)      await conn.close().catch(() => {});
  }
}

/**
 * Consulta dados básicos de uma pessoa pelo CPF.
 * Retorna { nm_pessoa, dt_nascimento (DD/MM/AAAA), ds_email } ou null se não encontrado.
 */
async function lookupPessoaFisica(cpf) {
  if (!cpf || !/^\d{11}$/.test(cpf)) return null;
  if (!ORACLE_CONFIG.user) return null;

  let conn;
  try {
    conn = await oracledb.getConnection({ ...ORACLE_CONFIG, connectTimeout: 5 });
    conn.callTimeout = 5000;
    const result = await conn.execute(
      `SELECT PF.NM_PESSOA_FISICA,
              PF.DT_NASCIMENTO,
              PF.NR_DDD_CELULAR,
              PF.NR_TELEFONE_CELULAR,
              (SELECT C.DS_EMAIL
                 FROM TASY.COMPL_PESSOA_FISICA C
                WHERE C.CD_PESSOA_FISICA = PF.CD_PESSOA_FISICA
                  AND C.DS_EMAIL IS NOT NULL
                ORDER BY CASE WHEN C.IE_CONTATO_PRINCIPAL = '1' THEN 0 ELSE 1 END,
                         C.NR_SEQUENCIA
                FETCH FIRST 1 ROW ONLY) AS DS_EMAIL
         FROM TASY.PESSOA_FISICA PF
        WHERE PF.NR_CPF = :cpf
          AND ROWNUM = 1`,
      { cpf },
      { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchArraySize: 1 }
    );

    if (!result.rows || result.rows.length === 0) return null;

    const row = result.rows[0];
    let dtFormatted = null;
    if (row.DT_NASCIMENTO instanceof Date) {
      const d = String(row.DT_NASCIMENTO.getDate()).padStart(2, '0');
      const m = String(row.DT_NASCIMENTO.getMonth() + 1).padStart(2, '0');
      const y = row.DT_NASCIMENTO.getFullYear();
      dtFormatted = `${d}/${m}/${y}`;
    }

    let nrTelefone = null;
    const ddd = row.NR_DDD_CELULAR ? String(row.NR_DDD_CELULAR).replace(/\D/g, '') : '';
    const cel = row.NR_TELEFONE_CELULAR ? String(row.NR_TELEFONE_CELULAR).replace(/\D/g, '') : '';
    if (ddd && cel) nrTelefone = ddd + cel;
    else if (cel) nrTelefone = cel;

    return {
      nm_pessoa:     row.NM_PESSOA_FISICA ? String(row.NM_PESSOA_FISICA).trim() : null,
      dt_nascimento: dtFormatted,
      ds_email:      row.DS_EMAIL ? String(row.DS_EMAIL).trim() : null,
      nr_telefone:   nrTelefone,
    };
  } catch (err) {
    logger.warn(`[Tasy] lookupPessoaFisica: ${err.message}`);
    return null;
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/**
 * Busca itens sem valor na INTERFACE_CONTA_ITEM_V do Oracle.
 */
async function queryItensSemValor({ dtInicio, dtFim, cdConvenio } = {}) {
  const hoje = new Date();
  const from = dtInicio || new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 30).toISOString().slice(0, 10);
  const to   = dtFim   || hoje.toISOString().slice(0, 10);

  const binds = { dtInicio: from, dtFim: to };
  const convenioClause = cdConvenio ? 'AND I.CD_CONVENIO = :cdConvenio' : '';
  if (cdConvenio) binds.cdConvenio = Number(cdConvenio);

  let conn;
  try {
    conn = await oracledb.getConnection({ ...ORACLE_CONFIG, connectTimeout: 8 });
    conn.callTimeout = 25000;

    const rResumo = await conn.execute(
      `SELECT I.CD_CONVENIO,
              COUNT(DISTINCT I.NR_ATENDIMENTO) AS QT_ATEND,
              COUNT(*) AS QT_ITENS
         FROM TASY.INTERFACE_CONTA_ITEM_V I
        WHERE (I.VL_ITEM IS NULL OR I.VL_ITEM = 0)
          AND I.DT_ITEM >= TO_DATE(:dtInicio, 'YYYY-MM-DD')
          AND I.DT_ITEM <  TO_DATE(:dtFim,    'YYYY-MM-DD') + 1
          ${convenioClause}
        GROUP BY I.CD_CONVENIO
        ORDER BY QT_ITENS DESC`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const rItens = await conn.execute(
      `SELECT I.NR_ATENDIMENTO,
              I.DS_ITEM,
              I.TP_ITEM,
              I.QT_ITEM,
              I.VL_ITEM,
              I.VL_UNITARIO,
              I.DT_ITEM,
              I.CD_CONVENIO,
              I.CD_SETOR_ATENDIMENTO
         FROM TASY.INTERFACE_CONTA_ITEM_V I
        WHERE (I.VL_ITEM IS NULL OR I.VL_ITEM = 0)
          AND I.DT_ITEM >= TO_DATE(:dtInicio, 'YYYY-MM-DD')
          AND I.DT_ITEM <  TO_DATE(:dtFim,    'YYYY-MM-DD') + 1
          ${convenioClause}
        ORDER BY I.DT_ITEM DESC
        FETCH FIRST 1000 ROWS ONLY`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const fDate = d => d instanceof Date
      ? d.toISOString().slice(0, 10)
      : (d ? String(d).slice(0, 10) : null);

    const resumo = rResumo.rows.map(r => ({
      cd_convenio: r.CD_CONVENIO,
      qt_atend:    Number(r.QT_ATEND || 0),
      qt_itens:    Number(r.QT_ITENS || 0),
    }));

    const TP_ITEM = { '1': 'Procedimento', '2': 'Material' };
    const itens = rItens.rows.map(r => ({
      nr_atendimento:       Number(r.NR_ATENDIMENTO),
      ds_item:              r.DS_ITEM || '—',
      tp_item:              TP_ITEM[String(r.TP_ITEM)] || r.TP_ITEM || '—',
      qt_item:              Number(r.QT_ITEM || 0),
      vl_item:              Number(r.VL_ITEM || 0),
      vl_unitario:          Number(r.VL_UNITARIO || 0),
      dt_item:              fDate(r.DT_ITEM),
      cd_convenio:          r.CD_CONVENIO,
      cd_setor_atendimento: r.CD_SETOR_ATENDIMENTO,
    }));

    return { resumo, itens, dtInicio: from, dtFim: to };
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/**
 * Consulta ocupação hospitalar em tempo real via OCUPACAO_SETORES_V e EIS_CENSO_DIARIO_V.
 */
async function queryOcupacaoHospitalar() {
  let conn;
  try {
    conn = await oracledb.getConnection({ ...ORACLE_CONFIG, connectTimeout: 8 });
    conn.callTimeout = 20000;

    const [rSetores, rCenso] = await Promise.all([
      conn.execute(
        `SELECT CD_SETOR_ATENDIMENTO,
                DS_SETOR_ATENDIMENTO,
                NR_UNIDADES_SETOR,
                NR_UNIDADES_OCUPADAS,
                NR_UNIDADES_LIVRES,
                NR_UNIDADES_INTERDITADAS,
                NR_UNIDADES_HIGIENIZACAO,
                NR_UNIDADES_RESERVADAS,
                QT_UNIDADES_ALTA,
                QT_PAC_ISOLADO,
                NM_UNIDADE
           FROM TASY.OCUPACAO_SETORES_V
          WHERE IE_OCUP_HOSPITALAR  IN ('S', 'T')
            AND IE_SITUACAO         = 'A'
            AND NR_UNIDADES_OCUPADAS > 0
          ORDER BY NR_UNIDADES_OCUPADAS DESC, DS_SETOR_ATENDIMENTO`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      ),

      conn.execute(
        `SELECT TRUNC(DT_REFERENCIA) AS DT,
                SUM(NR_PACIENTES)   AS TOT_PAC,
                SUM(NR_ADMISSOES)   AS ADMISSOES,
                SUM(NR_ALTAS)       AS ALTAS,
                SUM(NR_OBITOS)      AS OBITOS
           FROM TASY.EIS_CENSO_DIARIO_V
          WHERE DT_REFERENCIA >= TRUNC(SYSDATE) - 13
            AND IE_SITUACAO = 'A'
          GROUP BY TRUNC(DT_REFERENCIA)
          ORDER BY TRUNC(DT_REFERENCIA) ASC`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      ),
    ]);

    const fDate = d => d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null);

    const setores = rSetores.rows.map(r => ({
      cd_setor:         r.CD_SETOR_ATENDIMENTO,
      ds_setor:         String(r.DS_SETOR_ATENDIMENTO || '').trim(),
      nm_unidade:       r.NM_UNIDADE ? String(r.NM_UNIDADE).trim() : null,
      nr_total:         Number(r.NR_UNIDADES_SETOR       || 0),
      nr_ocupados:      Number(r.NR_UNIDADES_OCUPADAS    || 0),
      nr_livres:        Number(r.NR_UNIDADES_LIVRES       || 0),
      nr_interditados:  Number(r.NR_UNIDADES_INTERDITADAS || 0),
      nr_higienizacao:  Number(r.NR_UNIDADES_HIGIENIZACAO || 0),
      nr_reservados:    Number(r.NR_UNIDADES_RESERVADAS   || 0),
      qt_alta:          Number(r.QT_UNIDADES_ALTA         || 0),
      qt_isolado:       Number(r.QT_PAC_ISOLADO           || 0),
    }));

    const totais = setores.reduce((acc, s) => ({
      nr_total:        acc.nr_total        + s.nr_total,
      nr_ocupados:     acc.nr_ocupados     + s.nr_ocupados,
      nr_livres:       acc.nr_livres       + s.nr_livres,
      nr_interditados: acc.nr_interditados + s.nr_interditados,
      nr_higienizacao: acc.nr_higienizacao + s.nr_higienizacao,
      nr_reservados:   acc.nr_reservados   + s.nr_reservados,
      qt_alta:         acc.qt_alta         + s.qt_alta,
      qt_isolado:      acc.qt_isolado      + s.qt_isolado,
    }), { nr_total: 0, nr_ocupados: 0, nr_livres: 0, nr_interditados: 0, nr_higienizacao: 0, nr_reservados: 0, qt_alta: 0, qt_isolado: 0 });

    const censo14d = rCenso.rows.map(r => ({
      dt:         fDate(r.DT),
      tot_pac:    Number(r.TOT_PAC   || 0),
      admissoes:  Number(r.ADMISSOES || 0),
      altas:      Number(r.ALTAS     || 0),
      obitos:     Number(r.OBITOS    || 0),
    }));

    return { setores, totais, censo14d };
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/**
 * Consulta agenda de consultas em tempo real via TASY.AGENDA_CONSULTA.
 * Retorna resumo agrupado por agenda, convênio e forma de agendamento,
 * além de totais por situação (cards) para o período informado.
 */
async function queryAgendaConsulta({ dtInicio, dtFim } = {}) {
  let conn;
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const from = dtInicio || hoje;
    const to   = dtFim   || hoje;

    conn = await oracledb.getConnection({ ...ORACLE_CONFIG, connectTimeout: 8 });
    conn.callTimeout = 20000;

    const [rResumo, rSituacao] = await Promise.all([
      // Agrupamento principal: agenda × convênio × forma de agendamento
      conn.execute(
        `SELECT
           NVL(AC.NM_PRESTADOR,        '(Sem agenda)')    AS NM_AGENDA,
           NVL(AC.DS_CONVENIO,         '(Sem convênio)')  AS DS_CONVENIO,
           NVL(AC.IE_TIPO_AGENDAMENTO, 'N')               AS IE_TIPO_AGENDAMENTO,
           NVL(AC.IE_SITUACAO,         'N')               AS IE_SITUACAO,
           COUNT(*)                                        AS QT
         FROM TASY.AGENDA_CONSULTA AC
         WHERE TRUNC(AC.DT_AGENDA)
               BETWEEN TO_DATE(:dtIni, 'YYYY-MM-DD')
                   AND TO_DATE(:dtFim, 'YYYY-MM-DD')
         GROUP BY AC.NM_PRESTADOR, AC.DS_CONVENIO,
                  AC.IE_TIPO_AGENDAMENTO, AC.IE_SITUACAO
         ORDER BY NM_AGENDA, QT DESC`,
        { dtIni: from, dtFim: to },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      ),

      // Totais por situação (para os cards de resumo)
      conn.execute(
        `SELECT
           NVL(IE_SITUACAO, 'N') AS IE_SITUACAO,
           COUNT(*)              AS QT
         FROM TASY.AGENDA_CONSULTA
         WHERE TRUNC(DT_AGENDA)
               BETWEEN TO_DATE(:dtIni, 'YYYY-MM-DD')
                   AND TO_DATE(:dtFim, 'YYYY-MM-DD')
         GROUP BY IE_SITUACAO
         ORDER BY QT DESC`,
        { dtIni: from, dtFim: to },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      ),
    ]);

    // Mapeamentos de label
    const SITUACAO_LABEL = {
      A: 'Agendado',  R: 'Realizado', C: 'Cancelado',
      F: 'Faltou',    L: 'Liberado',  S: 'Suspenso',  N: '(Sem status)',
    };
    const TIPO_AGND_LABEL = {
      P: 'Presencial', I: 'Internet',  T: 'Telefone',
      C: 'Central',    W: 'WhatsApp',  N: '(Não informado)',
      // numéricos (algumas versões do Tasy)
      '1': 'Presencial', '2': 'Internet', '3': 'Telefone',
      '4': 'Central',    '5': 'WhatsApp',
    };

    const resumo = rResumo.rows.map(r => ({
      nm_agenda:            String(r.NM_AGENDA   || '').trim(),
      ds_convenio:          String(r.DS_CONVENIO || '').trim(),
      ie_tipo_agendamento:  String(r.IE_TIPO_AGENDAMENTO || 'N'),
      ds_tipo_agendamento:  TIPO_AGND_LABEL[String(r.IE_TIPO_AGENDAMENTO || 'N')] || String(r.IE_TIPO_AGENDAMENTO),
      ie_situacao:          String(r.IE_SITUACAO || 'N'),
      ds_situacao:          SITUACAO_LABEL[String(r.IE_SITUACAO || 'N')]  || String(r.IE_SITUACAO),
      qt:                   Number(r.QT || 0),
    }));

    // Cards: total e por situação
    const situacaoMap = {};
    let total = 0;
    for (const r of rSituacao.rows) {
      const key = String(r.IE_SITUACAO || 'N');
      const qt  = Number(r.QT || 0);
      situacaoMap[key] = { label: SITUACAO_LABEL[key] || key, qt };
      total += qt;
    }

    return { resumo, situacaoMap, total, dtInicio: from, dtFim: to };
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

module.exports = { discoverColumns, syncContas, syncProtocolos, lookupPessoaFisica, queryItensSemValor, queryOcupacaoHospitalar, queryAgendaConsulta };
