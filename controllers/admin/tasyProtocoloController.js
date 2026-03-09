const { Op, fn, col } = require('sequelize');
const { TasyProtocolo, TasyConta } = require('../../models');
const logger = require('../../utils/logger');
const { PAGE_SIZE, escapeCSV } = require('./helpers');

const STATUS_VALID = ['rascunho', 'enviado', 'faturado', 'pago', 'cancelado'];

function formatBRL(val) {
  return (Number(val) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function buildWhere(query) {
  const where = {};
  if (query.status && STATUS_VALID.includes(query.status)) where.status = query.status;
  if (query.convenio) where.ds_convenio = { [Op.iLike]: `%${query.convenio}%` };
  return where;
}

function toJSON(p) {
  const o = p.toJSON ? p.toJSON() : { ...p };
  return {
    ...o,
    vl_total_fmt:       formatBRL(o.vl_total),
    dt_emissao_fmt:     o.dt_emissao     || '—',
    dt_envio_fmt:       o.dt_envio       || '—',
    dt_faturamento_fmt: o.dt_faturamento || '—',
    dt_pagamento_fmt:   o.dt_pagamento   || '—',
  };
}

// GET /admin/tasy/protocolos
exports.list = async (req, res) => {
  try {
    const page = Math.min(10000, Math.max(0, parseInt(req.query.page || '0', 10) || 0));
    const where = buildWhere(req.query);

    const [{ count, rows }, resumo, convenios] = await Promise.all([
      TasyProtocolo.findAndCountAll({
        where,
        order: [['dt_emissao', 'DESC'], ['createdAt', 'DESC']],
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
      TasyProtocolo.findAll({
        attributes: [
          'status',
          [fn('COUNT', col('id')), 'qt'],
          [fn('SUM', col('vl_total')), 'vl'],
        ],
        group: ['status'],
        raw: true,
      }),
      TasyConta.findAll({
        attributes: [[fn('DISTINCT', col('ds_convenio')), 'ds_convenio']],
        where: { ds_convenio: { [Op.ne]: null } },
        order: [['ds_convenio', 'ASC']],
        raw: true,
      }),
    ]);

    const cards = {};
    for (const s of STATUS_VALID) {
      const r = resumo.find(x => x.status === s) || {};
      cards[s] = { qt: Number(r.qt || 0), vl: formatBRL(r.vl || 0) };
    }

    res.render('admin/tasy_protocolos', {
      page: 'tasy',
      protocolos: rows.map(toJSON),
      cards,
      convenios: convenios.map(r => r.ds_convenio).filter(Boolean),
      filters: req.query,
      pageNum: page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total: count,
      csrfToken: req.session.csrfToken,
    });
  } catch (err) {
    logger.error(`[TasyProtocolo] list: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// GET /admin/tasy/protocolos/preview  (AJAX: retorna qt e vl para preview de criação)
exports.preview = async (req, res) => {
  try {
    const { convenio, dtInicio, dtFim } = req.query;
    if (!convenio) return res.json({ qt: 0, vl: 0, vlFmt: formatBRL(0) });

    const where = { ds_convenio: convenio };
    if (dtInicio || dtFim) {
      where.dt_entrada = {};
      if (dtInicio) where.dt_entrada[Op.gte] = dtInicio;
      if (dtFim)    where.dt_entrada[Op.lte] = dtFim;
    }

    const result = await TasyConta.findAll({
      attributes: [
        [fn('COUNT', col('id')), 'qt'],
        [fn('SUM', col('vl_conta')), 'vl'],
      ],
      where,
      raw: true,
    });

    const qt = Number(result[0]?.qt || 0);
    const vl = Number(result[0]?.vl || 0);
    res.json({ qt, vl, vlFmt: formatBRL(vl) });
  } catch (err) {
    logger.error(`[TasyProtocolo] preview: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

// POST /admin/tasy/protocolos  (criar)
exports.criar = async (req, res) => {
  try {
    const { ds_convenio, dtInicio, dtFim, nr_protocolo, obs } = req.body;
    if (!ds_convenio) return res.redirect('/admin/tasy/protocolos?erro=convenio_obrigatorio');

    const where = { ds_convenio };
    if (dtInicio || dtFim) {
      where.dt_entrada = {};
      if (dtInicio) where.dt_entrada[Op.gte] = dtInicio;
      if (dtFim)    where.dt_entrada[Op.lte] = dtFim;
    }

    const result = await TasyConta.findAll({
      attributes: [
        [fn('COUNT', col('id')), 'qt'],
        [fn('SUM', col('vl_conta')), 'vl'],
      ],
      where,
      raw: true,
    });

    const qt = Number(result[0]?.qt || 0);
    const vl = Number(result[0]?.vl || 0);
    const nr = (nr_protocolo || '').trim() ||
      `PROT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-4)}`;

    await TasyProtocolo.create({
      nr_protocolo:  nr,
      ds_convenio,
      dt_inicio:     dtInicio  || null,
      dt_fim:        dtFim     || null,
      qt_contas:     qt,
      vl_total:      vl,
      status:        'rascunho',
      dt_emissao:    new Date().toISOString().slice(0, 10),
      obs:           obs || null,
    });

    res.redirect('/admin/tasy/protocolos');
  } catch (err) {
    logger.error(`[TasyProtocolo] criar: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// POST /admin/tasy/protocolos/:id/status  (atualizar status/NF via AJAX)
exports.atualizarStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, nr_nota_fiscal, dt_envio, dt_faturamento, dt_pagamento, obs } = req.body;

    if (status && !STATUS_VALID.includes(status))
      return res.status(400).json({ ok: false, error: 'Status inválido.' });

    const protocolo = await TasyProtocolo.findByPk(id);
    if (!protocolo) return res.status(404).json({ ok: false, error: 'Protocolo não encontrado.' });

    const updates = {};
    if (status)          updates.status         = status;
    if (nr_nota_fiscal !== undefined) updates.nr_nota_fiscal = nr_nota_fiscal || null;
    if (dt_envio       !== undefined) updates.dt_envio       = dt_envio       || null;
    if (dt_faturamento !== undefined) updates.dt_faturamento = dt_faturamento || null;
    if (dt_pagamento   !== undefined) updates.dt_pagamento   = dt_pagamento   || null;
    if (obs            !== undefined) updates.obs            = obs            || null;

    await protocolo.update(updates);
    res.json({ ok: true, protocolo: toJSON(protocolo) });
  } catch (err) {
    logger.error(`[TasyProtocolo] atualizarStatus: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Erro interno.' });
  }
};

// DELETE /admin/tasy/protocolos/:id
exports.excluir = async (req, res) => {
  try {
    const protocolo = await TasyProtocolo.findByPk(req.params.id);
    if (!protocolo) return res.status(404).json({ ok: false, error: 'Não encontrado.' });
    if (protocolo.status !== 'rascunho' && protocolo.status !== 'cancelado')
      return res.status(409).json({ ok: false, error: 'Apenas protocolos em rascunho ou cancelados podem ser excluídos.' });
    await protocolo.destroy();
    res.json({ ok: true });
  } catch (err) {
    logger.error(`[TasyProtocolo] excluir: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Erro interno.' });
  }
};
