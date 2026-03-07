const { Op, fn, col, literal } = require('sequelize');
const { TasyConta } = require('../../models');
const { syncContas } = require('../../services/tasyService');
const logger = require('../../utils/logger');
const { PAGE_SIZE, formatDate, escapeCSV } = require('./helpers');

// -------------------------------------------------
// Helpers internos
// -------------------------------------------------

function formatBRL(val) {
  const n = Number(val) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function buildWhere(query) {
  const { status, convenio, setor, dtInicio, dtFim, q } = query;
  const where = {};

  if (status && ['aberto', 'pendente', 'faturado', 'outro'].includes(status)) {
    where.status_categoria = status;
  }
  if (convenio) where.ds_convenio = { [Op.iLike]: `%${convenio}%` };
  if (setor)    where.ds_setor    = { [Op.iLike]: `%${setor}%` };

  if (dtInicio || dtFim) {
    where.dt_entrada = {};
    if (dtInicio) where.dt_entrada[Op.gte] = dtInicio;
    if (dtFim)    where.dt_entrada[Op.lte] = dtFim;
  }

  if (q) {
    const like = { [Op.iLike]: `%${q}%` };
    where[Op.or] = [
      { nm_paciente:    like },
      { nr_atendimento: like },
      { ds_convenio:    like },
    ];
  }

  return where;
}

async function getCards() {
  const categorias = ['aberto', 'pendente', 'faturado'];
  const results = await TasyConta.findAll({
    attributes: [
      'status_categoria',
      [fn('COUNT', col('id')), 'total'],
      [fn('SUM', col('vl_conta')), 'valor'],
    ],
    group: ['status_categoria'],
    raw: true,
  });

  const cards = {};
  for (const cat of categorias) {
    const row = results.find(r => r.status_categoria === cat) || {};
    cards[cat] = {
      total: Number(row.total || 0),
      valor: formatBRL(row.valor || 0),
      valorRaw: Number(row.valor || 0),
    };
  }
  // total geral
  cards.geral = {
    total: results.reduce((s, r) => s + Number(r.total || 0), 0),
    valor: formatBRL(results.reduce((s, r) => s + Number(r.valor || 0), 0)),
  };
  return cards;
}

async function getLastSync() {
  const last = await TasyConta.max('synced_at');
  return last ? formatDate(last) : null;
}

async function getChartData() {
  // Agrupa por mês + status_categoria dos últimos 12 meses
  const rows = await TasyConta.findAll({
    attributes: [
      [fn('TO_CHAR', col('dt_entrada'), 'YYYY-MM'), 'mes'],
      'status_categoria',
      [fn('COUNT', col('id')), 'total'],
      [fn('SUM', col('vl_conta')), 'valor'],
    ],
    where: {
      dt_entrada: { [Op.gte]: literal("CURRENT_DATE - INTERVAL '12 months'") },
    },
    group: [literal("TO_CHAR(dt_entrada, 'YYYY-MM')"), 'status_categoria'],
    order:  [[literal("TO_CHAR(dt_entrada, 'YYYY-MM')"), 'ASC']],
    raw: true,
  });
  return rows;
}

async function getConvenioList() {
  const rows = await TasyConta.findAll({
    attributes: [[fn('DISTINCT', col('ds_convenio')), 'ds_convenio']],
    where: { ds_convenio: { [Op.ne]: null } },
    order: [['ds_convenio', 'ASC']],
    raw: true,
  });
  return rows.map(r => r.ds_convenio).filter(Boolean);
}

async function getSetorList() {
  const rows = await TasyConta.findAll({
    attributes: [[fn('DISTINCT', col('ds_setor')), 'ds_setor']],
    where: { ds_setor: { [Op.ne]: null } },
    order: [['ds_setor', 'ASC']],
    raw: true,
  });
  return rows.map(r => r.ds_setor).filter(Boolean);
}

// -------------------------------------------------
// Handlers
// -------------------------------------------------

exports.dashboard = async (req, res) => {
  try {
    const page   = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const where  = buildWhere(req.query);

    const [cards, lastSync, convenios, setores, { count, rows }] = await Promise.all([
      getCards(),
      getLastSync(),
      getConvenioList(),
      getSetorList(),
      TasyConta.findAndCountAll({
        where,
        order: [['dt_entrada', 'DESC']],
        limit: PAGE_SIZE,
        offset,
      }),
    ]);

    const contas = rows.map(r => ({
      nr_atendimento:   r.nr_atendimento,
      nm_paciente:      r.nm_paciente      || '—',
      ds_convenio:      r.ds_convenio      || '—',
      ds_setor:         r.ds_setor         || '—',
      ds_status_origem: r.ds_status_origem || '—',
      status_categoria: r.status_categoria,
      vl_conta:         formatBRL(r.vl_conta),
      dt_entrada:       r.dt_entrada || '—',
      dt_saida:         r.dt_saida   || '—',
      dt_faturamento:   r.dt_faturamento || '—',
    }));

    res.render('admin/tasy', {
      page: 'tasy',
      cards,
      contas,
      lastSync,
      convenios,
      setores,
      filters: req.query,
      pageNum: page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total: count,
      csrfToken: req.session.csrfToken,
    });
  } catch (err) {
    logger.error(`[Tasy] Erro no dashboard: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.data = async (req, res) => {
  try {
    const [cards, lastSync, chartData] = await Promise.all([
      getCards(),
      getLastSync(),
      getChartData(),
    ]);
    res.json({ cards, lastSync, chartData });
  } catch (err) {
    logger.error(`[Tasy] Erro em /tasy/data: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

exports.export = async (req, res) => {
  try {
    const where = buildWhere(req.query);
    const rows  = await TasyConta.findAll({ where, order: [['dt_entrada', 'DESC']] });

    const header = 'Nº Atendimento,Paciente,Convênio,Setor,Status,Valor (R$),Entrada,Saída,Faturamento';
    const lines  = rows.map(r => [
      r.nr_atendimento,
      r.nm_paciente      || '',
      r.ds_convenio      || '',
      r.ds_setor         || '',
      r.ds_status_origem || '',
      Number(r.vl_conta  || 0).toFixed(2).replace('.', ','),
      r.dt_entrada       || '',
      r.dt_saida         || '',
      r.dt_faturamento   || '',
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contas_tasy_${date}.csv"`);
    res.send('\uFEFF' + header + '\n' + lines.join('\n'));
  } catch (err) {
    logger.error(`[Tasy] Erro no export: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.sync = async (req, res) => {
  try {
    const count = await syncContas();
    res.json({ ok: true, count });
  } catch (err) {
    logger.error(`[Tasy] Erro no sync manual: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
};
