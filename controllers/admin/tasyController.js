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

const TISS_TIPO = {
  '01': 'Consulta',
  '02': 'Internação',
  '03': 'SPSADT',
  '04': 'Outros',
};

function maskCpf(cpf) {
  if (!cpf) return null;
  const d = String(cpf).replace(/\D/g, '');
  if (d.length !== 11) return cpf;
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

// Normaliza query param para array, filtrando vazios
function toArray(val) {
  if (!val) return [];
  return (Array.isArray(val) ? val : [val]).map(v => String(v).trim()).filter(Boolean);
}

function buildWhere(query, activeConvenios = null) {
  const { dtInicio, dtFim, q, zeradas, cancelados, sem_protocolo } = query;
  const where = {};

  const statuses = toArray(query.status).filter(s => ['aberto', 'faturado', 'outro'].includes(s));
  if (statuses.length === 1) where.status_categoria = statuses[0];
  else if (statuses.length > 1) where.status_categoria = { [Op.in]: statuses };

  const convenios = toArray(query.convenio);
  if (convenios.length === 1) {
    where.ds_convenio = convenios[0];
  } else if (convenios.length > 1) {
    where.ds_convenio = { [Op.in]: convenios };
  } else if (activeConvenios && query.conv_inativos !== '1') {
    // Por padrão oculta contas de convênios sem atividade nos últimos 2 anos
    const ativos = activeConvenios.filter(c => c.ativo).map(c => c.nome);
    if (ativos.length > 0) where.ds_convenio = { [Op.in]: ativos };
  }

  const setores = toArray(query.setor);
  if (setores.length === 1) where.ds_setor = setores[0];
  else if (setores.length > 1) where.ds_setor = { [Op.in]: setores };

  const tipos = toArray(query.tipo);
  if (tipos.length === 1) where.ds_tipo_atendimento = tipos[0];
  else if (tipos.length > 1) where.ds_tipo_atendimento = { [Op.in]: tipos };

  const especialidades = toArray(query.especialidade);
  if (especialidades.length === 1) where.ds_especialidade = especialidades[0];
  else if (especialidades.length > 1) where.ds_especialidade = { [Op.in]: especialidades };

  if (dtInicio || dtFim) {
    where.dt_entrada = {};
    if (dtInicio) where.dt_entrada[Op.gte] = dtInicio;
    if (dtFim)    where.dt_entrada[Op.lte] = dtFim;
  }

  if (zeradas       === '1') where.vl_conta         = { [Op.or]: [0, null] };
  if (cancelados    === '1') where.ie_cancelamento  = { [Op.ne]: null };
  if (sem_protocolo === '1') where.nr_seq_protocolo = { [Op.is]: null };

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
  const categorias = ['aberto', 'faturado'];
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

async function getAging(where = {}) {
  // Filtra apenas contas abertas; ignora outras condições de status do where original
  const agingWhere = { ...where, status_categoria: 'aberto', ie_cancelamento: null };

  const rows = await TasyConta.findAll({
    attributes: [
      [literal(`CASE
        WHEN dt_entrada IS NULL                          THEN 'sem_data'
        WHEN CURRENT_DATE - dt_entrada::date <= 30       THEN '0_30'
        WHEN CURRENT_DATE - dt_entrada::date <= 60       THEN '31_60'
        WHEN CURRENT_DATE - dt_entrada::date <= 90       THEN '61_90'
        ELSE '90_mais'
      END`), 'faixa'],
      [fn('COUNT', col('id')), 'total'],
      [fn('SUM', col('vl_conta')), 'valor'],
    ],
    where: agingWhere,
    group: [literal(`CASE
      WHEN dt_entrada IS NULL                          THEN 'sem_data'
      WHEN CURRENT_DATE - dt_entrada::date <= 30       THEN '0_30'
      WHEN CURRENT_DATE - dt_entrada::date <= 60       THEN '31_60'
      WHEN CURRENT_DATE - dt_entrada::date <= 90       THEN '61_90'
      ELSE '90_mais'
    END`)],
    raw: true,
  });

  const BUCKETS = [
    { key: '0_30',    label: '0–30 dias' },
    { key: '31_60',   label: '31–60 dias' },
    { key: '61_90',   label: '61–90 dias' },
    { key: '90_mais', label: '90+ dias' },
    { key: 'sem_data',label: 'Sem data' },
  ];
  const map = {};
  rows.forEach(r => { map[r.faixa] = { total: Number(r.total || 0), valorRaw: Number(r.valor || 0) }; });

  return BUCKETS.map(b => ({
    ...b,
    total:    map[b.key]?.total    || 0,
    valorRaw: map[b.key]?.valorRaw || 0,
    valor:    formatBRL(map[b.key]?.valorRaw || 0),
  }));
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
  const threshold = new Date();
  threshold.setFullYear(threshold.getFullYear() - 2); // 2 anos sem atividade = inativo
  const threshStr = threshold.toISOString().slice(0, 10);

  const rows = await TasyConta.findAll({
    attributes: [
      'ds_convenio',
      [fn('MAX', col('dt_entrada')), 'ultima_entrada'],
    ],
    where: { ds_convenio: { [Op.ne]: null } },
    group: ['ds_convenio'],
    order: [['ds_convenio', 'ASC']],
    raw: true,
  });
  return rows
    .filter(r => r.ds_convenio)
    .map(r => ({
      nome:  r.ds_convenio,
      ativo: !r.ultima_entrada || r.ultima_entrada >= threshStr,
    }));
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

const VALID_SORTS = ['dt_entrada', 'vl_conta', 'vl_liquido', 'nm_paciente', 'ds_convenio', 'dt_conta_definitiva', 'nr_atendimento'];

exports.dashboard = async (req, res) => {
  try {
    const page    = Math.min(10000, Math.max(0, parseInt(req.query.page || '0', 10) || 0));
    const offset  = page * PAGE_SIZE;
    const sortCol = VALID_SORTS.includes(req.query.sort) ? req.query.sort : 'dt_entrada';
    const sortDir = req.query.order === 'asc' ? 'ASC' : 'DESC';

    const convenios = await getConvenioList();
    const where     = buildWhere(req.query, convenios);

    const [cards, aging, lastSync, setores, tipos, especialidades, chartData, { count, rows }] = await Promise.all([
      getCards(where),
      getAging(where),
      getLastSync(),
      getSetorList(),
      getTipoList(),
      getEspecialidadeList(),
      getChartData(where),
      TasyConta.findAndCountAll({
        where,
        order: [[sortCol, sortDir]],
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
      dt_entrada:          r.dt_entrada         || '—',
      dt_saida:            r.dt_saida           || '—',
      dt_faturamento:      r.dt_faturamento     || '—',
      dt_conta_definitiva: r.dt_conta_definitiva || null,
      dt_conta_protocolo:  r.dt_conta_protocolo  || null,
      cd_autorizacao:      r.cd_autorizacao     || null,
      nr_guia_prestador:   r.nr_guia_prestador  || null,
      nr_protocolo_conta:  r.nr_protocolo_conta || null,
      qt_dias_conta:       r.qt_dias_conta      ?? null,
      ds_inconsistencia:   r.ds_inconsistencia  || null,
      ie_tipo_atend_tiss:  r.ie_tipo_atend_tiss || null,
      ds_tipo_atend_tiss:  r.ie_tipo_atend_tiss ? (TISS_TIPO[r.ie_tipo_atend_tiss] || r.ie_tipo_atend_tiss) : null,
      ie_status_protocolo: r.ie_status_protocolo ?? null,
      ds_status_protocolo: r.ie_status_protocolo ? (STATUS_PROTOCOLO[r.ie_status_protocolo] || `Status ${r.ie_status_protocolo}`) : null,
      nr_seq_protocolo:    r.nr_seq_protocolo ?? null,
    }));

    res.render('admin/tasy', {
      page: 'tasy',
      cards,
      aging,
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
      sort: sortCol,
      order: sortDir,
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
    const activeConvenios = await getConvenioList();
    const where = buildWhere(req.query, activeConvenios);
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

exports.syncStream = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  syncContas(progress => send(progress))
    .then(count => { send({ done: true, count }); res.end(); })
    .catch(err => {
      logger.error(`[Tasy] syncStream: ${err.message}`);
      send({ error: err.message });
      res.end();
    });
};
