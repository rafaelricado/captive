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

const STATUS_PROTOCOLO = {
  1: 'Provisório',
  2: 'Definitivo',
  3: 'Auditoria',
  4: 'Perda',
  5: 'Cancelado',
};

function maskCpf(cpf) {
  if (!cpf) return null;
  const d = String(cpf).replace(/\D/g, '');
  if (d.length !== 11) return cpf;
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

function buildWhere(query) {
  const { status, convenio, setor, tipo, especialidade, dtInicio, dtFim, q, zeradas, cancelados } = query;
  const where = {};

  if (status && ['aberto', 'pendente', 'faturado', 'outro'].includes(status)) {
    where.status_categoria = status;
  }
  if (convenio)     where.ds_convenio         = { [Op.iLike]: `%${convenio}%` };
  if (setor)        where.ds_setor             = { [Op.iLike]: `%${setor}%` };
  if (tipo)         where.ds_tipo_atendimento  = { [Op.iLike]: `%${tipo}%` };
  if (especialidade) where.ds_especialidade    = { [Op.iLike]: `%${especialidade}%` };

  if (dtInicio || dtFim) {
    where.dt_entrada = {};
    if (dtInicio) where.dt_entrada[Op.gte] = dtInicio;
    if (dtFim)    where.dt_entrada[Op.lte] = dtFim;
  }

  if (zeradas   === '1') where.vl_conta      = { [Op.or]: [0, null] };
  if (cancelados === '1') where.ie_cancelamento = { [Op.ne]: null };

  if (q) {
    const like = { [Op.iLike]: `%${q}%` };
    where[Op.or] = [
      { nm_paciente:    like },
      { nr_atendimento: like },
      { ds_convenio:    like },
      { nm_medico:      like },
    ];
  }

  return where;
}

// Cards respeitam os filtros ativos
async function getCards(where = {}) {
  const categorias = ['aberto', 'pendente', 'faturado'];
  const [byStatus, glosa] = await Promise.all([
    TasyConta.findAll({
      attributes: [
        'status_categoria',
        [fn('COUNT', col('id')), 'total'],
        [fn('SUM', col('vl_conta')), 'valor'],
        [fn('SUM', col('vl_liquido')), 'liquido'],
      ],
      where,
      group: ['status_categoria'],
      raw: true,
    }),
    TasyConta.findAll({
      attributes: [
        [fn('SUM', col('vl_glosa')), 'total_glosa'],
        [fn('AVG', col('pr_glosa')), 'media_glosa'],
      ],
      where,
      raw: true,
    }),
  ]);

  const cards = {};
  for (const cat of categorias) {
    const row = byStatus.find(r => r.status_categoria === cat) || {};
    cards[cat] = {
      total:   Number(row.total   || 0),
      valor:   formatBRL(row.valor   || 0),
      liquido: formatBRL(row.liquido || 0),
      valorRaw:  Number(row.valor   || 0),
      liquidoRaw: Number(row.liquido || 0),
    };
  }
  cards.geral = {
    total:   byStatus.reduce((s, r) => s + Number(r.total || 0), 0),
    valor:   formatBRL(byStatus.reduce((s, r) => s + Number(r.valor   || 0), 0)),
    liquido: formatBRL(byStatus.reduce((s, r) => s + Number(r.liquido || 0), 0)),
  };
  cards.glosa = {
    valor:      formatBRL(glosa[0]?.total_glosa || 0),
    mediaPerc:  Number(glosa[0]?.media_glosa || 0).toFixed(1),
    valorRaw:   Number(glosa[0]?.total_glosa || 0),
  };
  return cards;
}

async function getLastSync() {
  const last = await TasyConta.max('synced_at');
  return last ? formatDate(last) : null;
}

// Gráfico mensal respeita os filtros ativos.
// Se não houver filtro de data, usa os últimos 12 meses.
async function getChartData(where = {}) {
  const chartWhere = { ...where };
  if (!chartWhere.dt_entrada) {
    const d = new Date();
    d.setMonth(d.getMonth() - 12);
    chartWhere.dt_entrada = { [Op.gte]: d.toISOString().slice(0, 10) };
  }

  const rows = await TasyConta.findAll({
    attributes: [
      [fn('TO_CHAR', col('dt_entrada'), 'YYYY-MM'), 'mes'],
      'status_categoria',
      [fn('COUNT', col('id')), 'total'],
      [fn('SUM', col('vl_conta')),   'valor'],
      [fn('SUM', col('vl_liquido')), 'liquido'],
      [fn('SUM', col('vl_glosa')),   'glosa'],
    ],
    where: chartWhere,
    group: [literal("TO_CHAR(dt_entrada, 'YYYY-MM')"), 'status_categoria'],
    order: [[literal("TO_CHAR(dt_entrada, 'YYYY-MM')"), 'ASC']],
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

async function getTipoList() {
  const rows = await TasyConta.findAll({
    attributes: [[fn('DISTINCT', col('ds_tipo_atendimento')), 'ds_tipo_atendimento']],
    where: { ds_tipo_atendimento: { [Op.ne]: null } },
    order: [['ds_tipo_atendimento', 'ASC']],
    raw: true,
  });
  return rows.map(r => r.ds_tipo_atendimento).filter(Boolean);
}

async function getEspecialidadeList() {
  const rows = await TasyConta.findAll({
    attributes: [[fn('DISTINCT', col('ds_especialidade')), 'ds_especialidade']],
    where: { ds_especialidade: { [Op.ne]: null } },
    order: [['ds_especialidade', 'ASC']],
    raw: true,
  });
  return rows.map(r => r.ds_especialidade).filter(Boolean);
}

// -------------------------------------------------
// Handlers
// -------------------------------------------------

exports.dashboard = async (req, res) => {
  try {
    const page   = Math.min(10000, Math.max(0, parseInt(req.query.page || '0', 10) || 0));
    const offset = page * PAGE_SIZE;
    const where  = buildWhere(req.query);

    const [cards, lastSync, convenios, setores, tipos, especialidades, chartData, { count, rows }] = await Promise.all([
      getCards(where),
      getLastSync(),
      getConvenioList(),
      getSetorList(),
      getTipoList(),
      getEspecialidadeList(),
      getChartData(where),
      TasyConta.findAndCountAll({
        where,
        order: [['dt_entrada', 'DESC']],
        limit: PAGE_SIZE,
        offset,
      }),
    ]);

    const contas = rows.map(r => ({
      nr_atendimento:      r.nr_atendimento,
      nm_paciente:         r.nm_paciente         || '—',
      cd_pessoa_fisica:    maskCpf(r.cd_pessoa_fisica),
      ds_convenio:         r.ds_convenio         || '—',
      ds_plano:            r.ds_plano            || null,
      ds_setor:            r.ds_setor            || '—',
      ds_tipo_atendimento: r.ds_tipo_atendimento || '—',
      nm_medico:           r.nm_medico           || '—',
      ds_especialidade:    r.ds_especialidade    || null,
      ds_status_origem:    r.ds_status_origem    || '—',
      status_categoria:    r.status_categoria,
      ie_cancelamento:     r.ie_cancelamento,
      vl_conta:            formatBRL(r.vl_conta),
      vl_glosa:            formatBRL(r.vl_glosa),
      pr_glosa:            Number(r.pr_glosa || 0).toFixed(1),
      vl_liquido:          formatBRL(r.vl_liquido),
      dt_entrada:          r.dt_entrada    || '—',
      dt_saida:            r.dt_saida      || '—',
      dt_faturamento:      r.dt_faturamento || '—',
      ie_status_protocolo: r.ie_status_protocolo ?? null,
      ds_status_protocolo: r.ie_status_protocolo ? (STATUS_PROTOCOLO[r.ie_status_protocolo] || `Status ${r.ie_status_protocolo}`) : null,
      nr_seq_protocolo:    r.nr_seq_protocolo ?? null,
    }));

    res.render('admin/tasy', {
      page: 'tasy',
      cards,
      contas,
      lastSync,
      convenios,
      setores,
      tipos,
      especialidades,
      filters: req.query,
      chartData: JSON.stringify(chartData),
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
    const where = buildWhere(req.query);
    const [cards, lastSync, chartData] = await Promise.all([
      getCards(where),
      getLastSync(),
      getChartData(where),
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

    const header = 'Nº Atendimento,Paciente,CPF,Convênio,Plano,Tipo Atend.,Médico,Especialidade,Setor,Status,Faturado,Glosa (R$),Glosa (%),Líquido,Entrada,Saída,Faturamento,Status Protocolo,Nº Protocolo';
    const lines  = rows.map(r => [
      r.nr_atendimento,
      r.nm_paciente              || '',
      maskCpf(r.cd_pessoa_fisica) || '',
      r.ds_convenio              || '',
      r.ds_plano                 || '',
      r.ds_tipo_atendimento      || '',
      r.nm_medico                || '',
      r.ds_especialidade         || '',
      r.ds_setor                 || '',
      r.ds_status_origem         || '',
      Number(r.vl_conta   || 0).toFixed(2).replace('.', ','),
      Number(r.vl_glosa   || 0).toFixed(2).replace('.', ','),
      Number(r.pr_glosa   || 0).toFixed(1).replace('.', ','),
      Number(r.vl_liquido || 0).toFixed(2).replace('.', ','),
      r.dt_entrada       || '',
      r.dt_saida         || '',
      r.dt_faturamento   || '',
      r.ie_status_protocolo ? (STATUS_PROTOCOLO[r.ie_status_protocolo] || String(r.ie_status_protocolo)) : '',
      r.nr_seq_protocolo || '',
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
