const { Op, fn, col, literal } = require('sequelize');
const { TasyProtocolo, TasyConta } = require('../../../models');
const { syncProtocolos } = require('../services/tasyService');
const logger = require('../../../utils/logger');
const { PAGE_SIZE, formatDate, escapeCSV } = require('../../../controllers/admin/helpers');

function formatBRL(val) {
  return (Number(val) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const STATUS_PROTOCOLO = {
  1: 'Provisório',
  2: 'Definitivo',
  3: 'Auditoria',
  4: 'Perda',
  5: 'Cancelado',
};

function toArray(val) {
  if (!val) return [];
  return (Array.isArray(val) ? val : [val]).map(v => String(v).trim()).filter(Boolean);
}

function buildWhere(query) {
  const where = { nr_seq_protocolo: { [Op.ne]: null } };

  const statuses = toArray(query.status).map(Number).filter(n => [1, 2, 3, 4, 5].includes(n));
  if (statuses.length === 1) where.ie_status_protocolo = statuses[0];
  else if (statuses.length > 1) where.ie_status_protocolo = { [Op.in]: statuses };

  const convenios = toArray(query.convenio).map(Number).filter(Boolean);
  if (convenios.length === 1) where.cd_convenio = convenios[0];
  else if (convenios.length > 1) where.cd_convenio = { [Op.in]: convenios };

  if (query.dtInicio || query.dtFim) {
    where.dt_periodo_inicial = {};
    if (query.dtInicio) where.dt_periodo_inicial[Op.gte] = query.dtInicio;
    if (query.dtFim)    where.dt_periodo_inicial[Op.lte] = query.dtFim;
  }

  if (query.q) {
    where[Op.or] = [
      { nr_protocolo: { [Op.iLike]: `%${query.q}%` } },
      { ds_observacao: { [Op.iLike]: `%${query.q}%` } },
    ];
  }

  return where;
}

async function getCards(where) {
  const [protAgg, allProts] = await Promise.all([
    TasyProtocolo.findAll({
      attributes: [
        'ie_status_protocolo',
        [fn('COUNT', col('id')), 'qt'],
        [fn('SUM', col('vl_recebimento')), 'vl_receb'],
      ],
      where,
      group: ['ie_status_protocolo'],
      raw: true,
    }),
    TasyProtocolo.findAll({
      attributes: ['nr_seq_protocolo', 'ie_status_protocolo'],
      where,
      raw: true,
    }),
  ]);

  const seqStatusMap = new Map();
  const seqs = [];
  for (const r of allProts) {
    if (r.nr_seq_protocolo != null) {
      seqStatusMap.set(Number(r.nr_seq_protocolo), r.ie_status_protocolo);
      seqs.push(Number(r.nr_seq_protocolo));
    }
  }

  const contaByStatus = {};
  if (seqs.length) {
    const contaRows = await TasyConta.findAll({
      attributes: ['nr_seq_protocolo', [fn('SUM', col('vl_conta')), 'vl']],
      where: { nr_seq_protocolo: { [Op.in]: seqs } },
      group: ['nr_seq_protocolo'],
      raw: true,
    });
    for (const r of contaRows) {
      const status = seqStatusMap.get(Number(r.nr_seq_protocolo));
      if (status != null) {
        contaByStatus[status] = (contaByStatus[status] || 0) + Number(r.vl || 0);
      }
    }
  }

  const cards = {};
  for (const k of Object.keys(STATUS_PROTOCOLO)) {
    const n = Number(k);
    const r = protAgg.find(x => Number(x.ie_status_protocolo) === n) || {};
    cards[n] = {
      qt:          Number(r.qt || 0),
      vl:          formatBRL(r.vl_receb || 0),
      vlRaw:       Number(r.vl_receb || 0),
      vlContas:    formatBRL(contaByStatus[n] || 0),
      vlContasRaw: contaByStatus[n] || 0,
    };
  }
  cards.geral = {
    qt:          protAgg.reduce((s, r) => s + Number(r.qt || 0), 0),
    vl:          formatBRL(protAgg.reduce((s, r) => s + Number(r.vl_receb || 0), 0)),
    vlRaw:       protAgg.reduce((s, r) => s + Number(r.vl_receb || 0), 0),
    vlContas:    formatBRL(Object.values(contaByStatus).reduce((s, v) => s + v, 0)),
    vlContasRaw: Object.values(contaByStatus).reduce((s, v) => s + v, 0),
  };
  return cards;
}

async function getLastSync() {
  const last = await TasyProtocolo.max('synced_at', {
    where: { nr_seq_protocolo: { [Op.ne]: null } },
  });
  return last ? formatDate(last) : null;
}

async function getConvenioList() {
  const rows = await TasyProtocolo.findAll({
    attributes: ['cd_convenio', 'ds_nome_convenio'],
    where: { cd_convenio: { [Op.ne]: null }, nr_seq_protocolo: { [Op.ne]: null } },
    group: ['cd_convenio', 'ds_nome_convenio'],
    order: [['cd_convenio', 'ASC']],
    raw: true,
  });
  return rows
    .filter(r => r.cd_convenio != null)
    .map(r => ({ cd: r.cd_convenio, nome: r.ds_nome_convenio || `Conv. #${r.cd_convenio}` }));
}

async function getContasTotais(seqs) {
  if (!seqs.length) return new Map();
  const rows = await TasyConta.findAll({
    attributes: [
      'nr_seq_protocolo',
      [fn('COUNT', col('id')), 'qt'],
      [fn('SUM', col('vl_conta')), 'vl'],
    ],
    where: { nr_seq_protocolo: { [Op.in]: seqs } },
    group: ['nr_seq_protocolo'],
    raw: true,
  });
  const map = new Map();
  for (const r of rows) {
    map.set(Number(r.nr_seq_protocolo), { qt: Number(r.qt || 0), vl: Number(r.vl || 0) });
  }
  return map;
}

const VALID_SORTS = [
  'dt_periodo_inicial', 'vl_recebimento', 'nr_protocolo',
  'ie_status_protocolo', 'dt_definitivo', 'nr_seq_protocolo',
];

// GET /admin/tasy/protocolos
exports.list = async (req, res) => {
  try {
    const page    = Math.min(10000, Math.max(0, parseInt(req.query.page || '0', 10) || 0));
    const where   = buildWhere(req.query);
    const sortCol = VALID_SORTS.includes(req.query.sort) ? req.query.sort : 'dt_periodo_inicial';
    const sortDir = req.query.order === 'asc' ? 'ASC' : 'DESC';

    const [cards, lastSync, convenios, { count, rows }] = await Promise.all([
      getCards(where),
      getLastSync(),
      getConvenioList(),
      TasyProtocolo.findAndCountAll({
        where,
        order: [[sortCol, sortDir]],
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    ]);

    const seqs = rows.map(r => r.nr_seq_protocolo).filter(v => v != null);
    const contasTotais = await getContasTotais(seqs);

    const protocolos = rows.map(r => ({
      id:                  r.id,
      nr_seq_protocolo:    r.nr_seq_protocolo,
      nr_protocolo:        r.nr_protocolo        || '—',
      cd_convenio:         r.cd_convenio,
      ds_nome_convenio:    r.ds_nome_convenio || null,
      ie_status_protocolo: r.ie_status_protocolo,
      ds_status_protocolo: r.ie_status_protocolo
        ? (STATUS_PROTOCOLO[r.ie_status_protocolo] || `Status ${r.ie_status_protocolo}`)
        : '—',
      dt_periodo_inicial:  r.dt_periodo_inicial  || null,
      dt_periodo_final:    r.dt_periodo_final    || null,
      dt_geracao:          r.dt_geracao          ? formatDate(r.dt_geracao)    : null,
      dt_envio:            r.dt_envio            ? formatDate(r.dt_envio)      : null,
      dt_retorno:          r.dt_retorno          ? formatDate(r.dt_retorno)    : null,
      dt_definitivo:       r.dt_definitivo       ? formatDate(r.dt_definitivo) : null,
      dt_vencimento:       r.dt_vencimento       || null,
      dt_entrega_convenio: r.dt_entrega_convenio || null,
      vl_recebimento:      formatBRL(r.vl_recebimento),
      vl_recebimento_raw:  Number(r.vl_recebimento || 0),
      ds_inconsistencia:   r.ds_inconsistencia   || null,
      ds_observacao:       r.ds_observacao       || null,
      nm_usuario:          r.nm_usuario          || null,
      qt_contas:           contasTotais.get(r.nr_seq_protocolo)?.qt ?? 0,
      vl_contas_raw:       contasTotais.get(r.nr_seq_protocolo)?.vl ?? 0,
      vl_contas:           formatBRL(contasTotais.get(r.nr_seq_protocolo)?.vl ?? 0),
    }));

    res.render('admin/tasy_protocolos', {
      page:       'tasy',
      protocolos,
      cards,
      lastSync,
      convenios,
      statusMap:  STATUS_PROTOCOLO,
      filters:    req.query,
      pageNum:    page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total:      count,
      sort:       sortCol,
      order:      sortDir,
      csrfToken:  req.session.csrfToken,
    });
  } catch (err) {
    logger.error(`[TasyProtocolo] list: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// POST /admin/tasy/protocolos/sync
exports.sync = async (req, res) => {
  try {
    const count = await syncProtocolos();
    res.json({ ok: true, count });
  } catch (err) {
    logger.error(`[TasyProtocolo] sync: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
};

// GET /admin/tasy/protocolos/sync/stream  (SSE)
exports.syncStream = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  syncProtocolos(progress => send(progress))
    .then(count => { send({ done: true, count }); res.end(); })
    .catch(err => {
      logger.error(`[TasyProtocolo] syncStream: ${err.message}`);
      send({ error: err.message });
      res.end();
    });
};

// GET /admin/tasy/protocolos/export
exports.export = async (req, res) => {
  try {
    const where = buildWhere(req.query);
    const rows  = await TasyProtocolo.findAll({ where, order: [['dt_periodo_inicial', 'DESC']] });

    const header = 'Seq,Protocolo,Cod.Convenio,Status,Periodo Inicial,Periodo Final,Gerado em,Enviado em,Retorno,Definitivo,Vencimento,Entrega Conv.,Vl.Recebimento,Inconsistencia,Observacao';
    const lines = rows.map(r => [
      r.nr_seq_protocolo || '',
      r.nr_protocolo     || '',
      r.cd_convenio      || '',
      r.ie_status_protocolo ? (STATUS_PROTOCOLO[r.ie_status_protocolo] || String(r.ie_status_protocolo)) : '',
      r.dt_periodo_inicial   || '',
      r.dt_periodo_final     || '',
      r.dt_geracao           ? formatDate(r.dt_geracao)    : '',
      r.dt_envio             ? formatDate(r.dt_envio)      : '',
      r.dt_retorno           ? formatDate(r.dt_retorno)    : '',
      r.dt_definitivo        ? formatDate(r.dt_definitivo) : '',
      r.dt_vencimento        || '',
      r.dt_entrega_convenio  || '',
      Number(r.vl_recebimento || 0).toFixed(2).replace('.', ','),
      r.ds_inconsistencia || '',
      r.ds_observacao     || '',
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="protocolos_tasy_${date}.csv"`);
    res.send('\uFEFF' + header + '\n' + lines.join('\n'));
  } catch (err) {
    logger.error(`[TasyProtocolo] export: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// GET /admin/tasy/resumo
exports.resumo = async (req, res) => {
  try {
    const { dtInicio, dtFim } = req.query;

    const contaWhere = {};
    if (dtInicio || dtFim) {
      contaWhere.dt_entrada = {};
      if (dtInicio) contaWhere.dt_entrada[Op.gte] = dtInicio;
      if (dtFim)    contaWhere.dt_entrada[Op.lte] = dtFim;
    }

    const contaRows = await TasyConta.findAll({
      attributes: [
        'ds_convenio',
        [fn('COUNT', col('id')), 'qt'],
        [fn('SUM', col('vl_conta')), 'vl_conta'],
        [fn('SUM', col('vl_glosa')), 'vl_glosa'],
        [fn('SUM', col('vl_liquido')), 'vl_liquido'],
        [literal(`SUM(CASE WHEN status_categoria IN ('aberto','pendente') THEN 1 ELSE 0 END)`), 'qt_aberto'],
      ],
      where: contaWhere,
      group: ['ds_convenio'],
      order: [[fn('SUM', col('vl_conta')), 'DESC']],
      raw: true,
    });

    const contas = contaRows.map(r => ({
      ds_convenio:    r.ds_convenio || '(sem convênio)',
      qt:             Number(r.qt || 0),
      qt_aberto:      Number(r.qt_aberto || 0),
      vl_conta:       formatBRL(r.vl_conta || 0),
      vl_conta_raw:   Number(r.vl_conta || 0),
      vl_glosa:       formatBRL(r.vl_glosa || 0),
      vl_glosa_raw:   Number(r.vl_glosa || 0),
      vl_liquido:     formatBRL(r.vl_liquido || 0),
      vl_liquido_raw: Number(r.vl_liquido || 0),
    }));

    const protWhere = { nr_seq_protocolo: { [Op.ne]: null } };
    if (dtInicio || dtFim) {
      protWhere.dt_periodo_inicial = {};
      if (dtInicio) protWhere.dt_periodo_inicial[Op.gte] = dtInicio;
      if (dtFim)    protWhere.dt_periodo_inicial[Op.lte] = dtFim;
    }

    const protRows = await TasyProtocolo.findAll({
      attributes: [
        'cd_convenio',
        'ds_nome_convenio',
        [fn('COUNT', col('id')), 'qt'],
        [fn('SUM', col('vl_recebimento')), 'vl_receb'],
      ],
      where: protWhere,
      group: ['cd_convenio', 'ds_nome_convenio'],
      order: [[fn('SUM', col('vl_recebimento')), 'DESC']],
      raw: true,
    });

    const protocolos = protRows.map(r => ({
      cd_convenio:      r.cd_convenio,
      ds_nome_convenio: r.ds_nome_convenio || `Conv. #${r.cd_convenio}`,
      qt:               Number(r.qt || 0),
      vl_recebimento:   formatBRL(r.vl_receb || 0),
      vl_recebimento_raw: Number(r.vl_receb || 0),
    }));

    const totais = {
      qt:            contas.reduce((s, r) => s + r.qt, 0),
      qt_aberto:     contas.reduce((s, r) => s + r.qt_aberto, 0),
      cobrado:       formatBRL(contas.reduce((s, r) => s + r.vl_conta_raw, 0)),
      cobrado_raw:   contas.reduce((s, r) => s + r.vl_conta_raw, 0),
      glosa:         formatBRL(contas.reduce((s, r) => s + r.vl_glosa_raw, 0)),
      glosa_raw:     contas.reduce((s, r) => s + r.vl_glosa_raw, 0),
      liquido:       formatBRL(contas.reduce((s, r) => s + r.vl_liquido_raw, 0)),
      liquido_raw:   contas.reduce((s, r) => s + r.vl_liquido_raw, 0),
    };

    res.render('admin/tasy_resumo', {
      page:       'tasy',
      contas,
      protocolos,
      totais,
      filters:    req.query,
      csrfToken:  req.session.csrfToken,
    });
  } catch (err) {
    logger.error(`[TasyProtocolo] resumo: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// GET /admin/tasy/resumo/contas
exports.resumoContas = async (req, res) => {
  try {
    const { ds_convenio, dtInicio, dtFim } = req.query;

    const where = {};
    if (ds_convenio != null) {
      where.ds_convenio = ds_convenio === '' ? null : ds_convenio;
    }
    if (dtInicio || dtFim) {
      where.dt_entrada = {};
      if (dtInicio) where.dt_entrada[Op.gte] = dtInicio;
      if (dtFim)    where.dt_entrada[Op.lte] = dtFim;
    }

    const rows = await TasyConta.findAll({
      where,
      order: [
        [literal(`CASE WHEN status_categoria IN ('aberto','pendente') THEN 0 ELSE 1 END`), 'ASC'],
        ['dt_entrada', 'DESC'],
      ],
      limit: 2000,
      raw: true,
    });

    const abertas   = rows.filter(r => ['aberto', 'pendente'].includes(r.status_categoria));
    const fechadas  = rows.filter(r => !['aberto', 'pendente'].includes(r.status_categoria));

    function somaVl(arr, campo) { return arr.reduce((s, r) => s + Number(r[campo] || 0), 0); }

    res.render('admin/tasy_resumo_contas', {
      page:        'tasy',
      ds_convenio: ds_convenio || '(sem convênio)',
      abertas,
      fechadas,
      totAbertas: {
        qt:  abertas.length,
        vl_conta:   formatBRL(somaVl(abertas, 'vl_conta')),
        vl_glosa:   formatBRL(somaVl(abertas, 'vl_glosa')),
        vl_liquido: formatBRL(somaVl(abertas, 'vl_liquido')),
      },
      totFechadas: {
        qt:  fechadas.length,
        vl_conta:   formatBRL(somaVl(fechadas, 'vl_conta')),
        vl_glosa:   formatBRL(somaVl(fechadas, 'vl_glosa')),
        vl_liquido: formatBRL(somaVl(fechadas, 'vl_liquido')),
      },
      filters:    req.query,
      csrfToken:  req.session.csrfToken,
    });
  } catch (err) {
    logger.error(`[TasyProtocolo] resumoContas: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// GET /admin/tasy/resumo/export
exports.resumoExport = async (req, res) => {
  try {
    const { dtInicio, dtFim } = req.query;
    const contaWhere = {};
    if (dtInicio || dtFim) {
      contaWhere.dt_entrada = {};
      if (dtInicio) contaWhere.dt_entrada[Op.gte] = dtInicio;
      if (dtFim)    contaWhere.dt_entrada[Op.lte] = dtFim;
    }
    const rows = await TasyConta.findAll({
      attributes: [
        'ds_convenio',
        [fn('COUNT', col('id')), 'qt'],
        [fn('SUM', col('vl_conta')), 'vl_conta'],
        [fn('SUM', col('vl_glosa')), 'vl_glosa'],
        [fn('SUM', col('vl_liquido')), 'vl_liquido'],
        [literal(`SUM(CASE WHEN status_categoria IN ('aberto','pendente') THEN 1 ELSE 0 END)`), 'qt_aberto'],
      ],
      where: contaWhere,
      group: ['ds_convenio'],
      order: [[fn('SUM', col('vl_conta')), 'DESC']],
      raw: true,
    });
    const header = 'Convenio,Total Contas,Em Aberto,Cobrado do Convenio,Glosa,% Glosa,Liquido Aprovado';
    const lines = rows.map(r => {
      const vl = Number(r.vl_conta || 0);
      const gl = Number(r.vl_glosa || 0);
      return [
        r.ds_convenio || '',
        Number(r.qt || 0),
        Number(r.qt_aberto || 0),
        vl.toFixed(2).replace('.', ','),
        gl.toFixed(2).replace('.', ','),
        vl > 0 ? ((gl / vl) * 100).toFixed(1) : '0,0',
        Number(r.vl_liquido || 0).toFixed(2).replace('.', ','),
      ].map(escapeCSV).join(',');
    });
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="resumo_convenios_${date}.csv"`);
    res.send('\uFEFF' + header + '\n' + lines.join('\n'));
  } catch (err) {
    logger.error(`[TasyProtocolo] resumoExport: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// GET /admin/tasy/resumo/contas/export
exports.resumoContasExport = async (req, res) => {
  try {
    const { ds_convenio, dtInicio, dtFim } = req.query;
    const where = {};
    if (ds_convenio != null) where.ds_convenio = ds_convenio === '' ? null : ds_convenio;
    if (dtInicio || dtFim) {
      where.dt_entrada = {};
      if (dtInicio) where.dt_entrada[Op.gte] = dtInicio;
      if (dtFim)    where.dt_entrada[Op.lte] = dtFim;
    }
    const rows = await TasyConta.findAll({
      where,
      order: [
        [literal(`CASE WHEN status_categoria IN ('aberto','pendente') THEN 0 ELSE 1 END`), 'ASC'],
        ['dt_entrada', 'DESC'],
      ],
      raw: true,
    });
    const header = 'Situacao,Atendimento,Paciente,Convenio,Plano,Status,Entrada,Saida,Cobrado,Glosa,% Glosa,Liquido';
    const lines = rows.map(r => {
      const vl = Number(r.vl_conta || 0);
      const gl = Number(r.vl_glosa || 0);
      return [
        ['aberto','pendente'].includes(r.status_categoria) ? 'Em Aberto' : 'Fechada',
        r.nr_atendimento || '',
        r.nm_paciente    || '',
        r.ds_convenio    || '',
        r.ds_plano       || '',
        r.status_categoria || '',
        r.dt_entrada     || '',
        r.dt_saida       || '',
        vl.toFixed(2).replace('.', ','),
        gl.toFixed(2).replace('.', ','),
        vl > 0 ? ((gl / vl) * 100).toFixed(1) : '0,0',
        Number(r.vl_liquido || 0).toFixed(2).replace('.', ','),
      ].map(escapeCSV).join(',');
    });
    const conv = (ds_convenio || 'todas').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contas_${conv}_${date}.csv"`);
    res.send('\uFEFF' + header + '\n' + lines.join('\n'));
  } catch (err) {
    logger.error(`[TasyProtocolo] resumoContasExport: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// GET /admin/tasy/resumo/protocolos
exports.resumoProtocolos = async (req, res) => {
  try {
    const { cd_convenio, dtInicio, dtFim } = req.query;
    const where = { nr_seq_protocolo: { [Op.ne]: null } };
    if (cd_convenio) where.cd_convenio = Number(cd_convenio);
    if (dtInicio || dtFim) {
      where.dt_periodo_inicial = {};
      if (dtInicio) where.dt_periodo_inicial[Op.gte] = dtInicio;
      if (dtFim)    where.dt_periodo_inicial[Op.lte] = dtFim;
    }

    const rows = await TasyProtocolo.findAll({
      where,
      order: [['dt_periodo_inicial', 'DESC']],
      limit: 2000,
      raw: true,
    });

    const ds_nome = rows[0]?.ds_nome_convenio || `Conv. #${cd_convenio}`;

    function somaVl(campo) { return rows.reduce((s, r) => s + Number(r[campo] || 0), 0); }
    const totais = {
      qt:         rows.length,
      recebimento: formatBRL(somaVl('vl_recebimento')),
    };

    const porStatus = {};
    for (const k of Object.keys(STATUS_PROTOCOLO)) {
      const n = Number(k);
      const subset = rows.filter(r => r.ie_status_protocolo === n);
      const vlRaw = subset.reduce((s, r) => s + Number(r.vl_recebimento || 0), 0);
      porStatus[n] = { label: STATUS_PROTOCOLO[n], qt: subset.length, vl: formatBRL(vlRaw), vl_raw: vlRaw };
    }

    res.render('admin/tasy_resumo_protocolos', {
      page:        'tasy',
      ds_nome_convenio: ds_nome,
      cd_convenio,
      rows: rows.map(r => ({
        ...r,
        ds_status: STATUS_PROTOCOLO[r.ie_status_protocolo] || `Status ${r.ie_status_protocolo}`,
        vl_recebimento_fmt: formatBRL(r.vl_recebimento),
        dt_periodo_inicial_fmt: r.dt_periodo_inicial || '—',
        dt_periodo_final_fmt:   r.dt_periodo_final   || '—',
        dt_definitivo_fmt:      r.dt_definitivo ? formatDate(r.dt_definitivo) : '—',
      })),
      totais,
      porStatus,
      truncated: rows.length >= 2000,
      filters:    req.query,
      csrfToken:  req.session.csrfToken,
    });
  } catch (err) {
    logger.error(`[TasyProtocolo] resumoProtocolos: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};
