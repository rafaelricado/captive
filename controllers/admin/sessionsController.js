const { Op } = require('sequelize');
const { User, Session } = require('../../models');
const mikrotikService = require('../../services/mikrotikService');
const logger = require('../../utils/logger');
const { audit } = require('../../utils/auditLogger');
const { PAGE_SIZE, DISPLAY_TIMEZONE, formatDate, escapeCSV } = require('./helpers');

exports.sessions = async (req, res) => {
  try {
    const page         = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset       = page * PAGE_SIZE;
    const now          = new Date();
    const statusFilter = ['active', 'expired'].includes(req.query.status) ? req.query.status : '';

    const where = {};
    if (statusFilter === 'active')  { where.active = true;  where.expires_at = { [Op.gt]: now }; }
    if (statusFilter === 'expired') { where[Op.or] = [{ active: false }, { expires_at: { [Op.lte]: now } }]; }

    const [{ count, rows }, totalActive, totalExpired] = await Promise.all([
      Session.findAndCountAll({
        where,
        include: [{ model: User, attributes: ['nome_completo'] }],
        distinct: true,
        order: [['started_at', 'DESC']],
        limit: PAGE_SIZE,
        offset
      }),
      Session.count({ where: { active: true, expires_at: { [Op.gt]: now } } }),
      Session.count({ where: { [Op.or]: [{ active: false }, { expires_at: { [Op.lte]: now } }] } })
    ]);

    const sessions = rows.map(s => ({
      id:         s.id,
      nome:       s.User ? s.User.nome_completo : '—',
      ip:         s.ip_address || '—',
      mac:        s.mac_address || '—',
      started_at: formatDate(s.started_at),
      expires_at: formatDate(s.expires_at),
      status:     s.active && new Date(s.expires_at) > now ? 'Ativa' : 'Expirada'
    }));

    res.render('admin/sessions', {
      sessions, page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total: count,
      pageLabel: page + 1,
      pageObj: 'sessions',
      statusFilter,
      totalActive,
      totalExpired,
      totalAll: totalActive + totalExpired
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar sessões: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.exportSessions = async (req, res) => {
  try {
    const now  = new Date();
    const rows = await Session.findAll({
      include: [{ model: User, attributes: ['nome_completo'] }],
      order: [['started_at', 'DESC']]
    });

    const header = 'Nome,IP,MAC,Inicio,Expiracao,Status';
    const lines  = rows.map(s => [
      s.User ? s.User.nome_completo : '',
      s.ip_address || '', s.mac_address || '',
      new Date(s.started_at).toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE }),
      new Date(s.expires_at).toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE }),
      s.active && new Date(s.expires_at) > now ? 'Ativa' : 'Expirada'
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sessoes_${date}.csv"`);
    audit('sessions.export', { count: rows.length, ip: req.ip });
    res.send('\uFEFF' + header + '\n' + lines.join('\n'));
  } catch (err) {
    logger.error(`[Admin] Erro ao exportar sessões: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.terminateSession = async (req, res) => {
  try {
    const sess = await Session.findByPk(req.params.id, {
      include: [{ model: User, attributes: ['cpf'] }]
    });
    if (!sess || !sess.active) return res.redirect('/admin/sessions');

    await mikrotikService.removeUser(sess.User.cpf);
    sess.active = false;
    await sess.save();

    logger.info(`[Admin] Sessão ${sess.id} encerrada manualmente`);
    audit('session.terminate', { sessionId: sess.id, ip: req.ip });
    res.redirect('/admin/sessions');
  } catch (err) {
    logger.error(`[Admin] Erro ao encerrar sessão: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};
