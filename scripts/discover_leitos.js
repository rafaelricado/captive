/**
 * discover_leitos.js
 * Roda no servidor para descobrir tabelas/views Oracle relacionadas a leitos e ocupação.
 * Uso: node scripts/discover_leitos.js
 */

require('dotenv').config();
const oracledb = require('oracledb');
oracledb.initOracleClient({ libDir: '/opt/oracle/instantclient_21_10' });

const ORACLE_CONFIG = {
  user:          process.env.TASY_USER,
  password:      process.env.TASY_PASS,
  connectString: `${process.env.TASY_HOST || '192.168.0.201'}:${process.env.TASY_PORT || 1521}/${process.env.TASY_SERVICE || 'dbprod'}`,
};

const KEYWORDS = ['LEITO', 'OCUPACAO', 'INTERNACAO', 'QUARTO', 'UNIDADE_INT', 'MOVIMENTO', 'CENSO'];

async function main() {
  let conn;
  try {
    conn = await oracledb.getConnection(ORACLE_CONFIG);
    conn.callTimeout = 30000;
    console.log('Conectado ao Oracle.\n');

    // 1. Tabelas/Views por palavra-chave
    for (const kw of KEYWORDS) {
      const res = await conn.execute(
        `SELECT OBJECT_NAME, OBJECT_TYPE
           FROM ALL_OBJECTS
          WHERE OWNER = 'TASY'
            AND OBJECT_NAME LIKE :kw
          ORDER BY OBJECT_TYPE, OBJECT_NAME`,
        { kw: `%${kw}%` },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      if (res.rows.length > 0) {
        console.log(`=== ${kw} ===`);
        res.rows.forEach(r => console.log(`  ${r.OBJECT_TYPE.padEnd(8)} ${r.OBJECT_NAME}`));
        console.log();
      }
    }

    // 2. Colunas de ATENDIMENTO_LEITO (se existir)
    const tables = ['ATENDIMENTO_LEITO', 'LEITO', 'QUARTO', 'UNIDADE_INTERNACAO', 'CENSO_LEITO', 'INTERNACAO'];
    for (const tbl of tables) {
      const res = await conn.execute(
        `SELECT COLUMN_NAME, DATA_TYPE
           FROM ALL_TAB_COLUMNS
          WHERE OWNER = 'TASY' AND TABLE_NAME = :tbl
          ORDER BY COLUMN_ID`,
        { tbl },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      if (res.rows.length > 0) {
        console.log(`\n--- Colunas de TASY.${tbl} ---`);
        res.rows.forEach(r => console.log(`  ${r.COLUMN_NAME} (${r.DATA_TYPE})`));
      }
    }

    // 3. Amostra de ATENDIMENTO_PACIENTE com campos de leito
    console.log('\n--- Amostra ATENDIMENTO_PACIENTE (10 linhas, colunas leito) ---');
    try {
      const ap = await conn.execute(
        `SELECT AP.NR_ATENDIMENTO, AP.CD_LEITO, AP.CD_SETOR_ATENDIMENTO,
                AP.IE_SITUACAO, AP.DT_ENTRADA, AP.DT_ALTA
           FROM TASY.ATENDIMENTO_PACIENTE AP
          WHERE AP.DT_ENTRADA >= SYSDATE - 30
            AND AP.IE_SITUACAO IN ('A', 'I')
            AND ROWNUM <= 10`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      ap.rows.forEach(r => console.log(JSON.stringify(r)));
    } catch (e) {
      console.log('  Erro:', e.message);
    }

    // 4. Contagem de internados ativos
    console.log('\n--- Contagem internados ativos (IE_SITUACAO=A) ---');
    try {
      const cnt = await conn.execute(
        `SELECT COUNT(*) AS QT FROM TASY.ATENDIMENTO_PACIENTE WHERE IE_SITUACAO = 'A'`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      console.log('  QT internados ativos:', cnt.rows[0].QT);
    } catch (e) {
      console.log('  Erro:', e.message);
    }

  } finally {
    if (conn) await conn.close().catch(() => {});
    console.log('\nFim.');
  }
}

main().catch(console.error);
