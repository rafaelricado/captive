const { AccessPoint, ApPingHistory } = require('../../models');
const { pingAllAccessPoints, isValidIPv4 } = require('../../services/pingService');
const logger = require('../../utils/logger');
const { audit } = require('../../utils/auditLogger');
const { formatDate } = require('./helpers');

exports.accessPoints = async (req, res) => {
  try {
    const aps  = await AccessPoint.findAll({ order: [['name', 'ASC']] });

    const list = aps.map(ap => ({
      id:              ap.id,
      name:            ap.name,
      ip_address:      ap.ip_address,
      location:        ap.location || '—',
      active:          ap.active,
      is_online:       ap.is_online,
      latency_ms:      ap.latency_ms,
      last_checked_at: ap.last_checked_at ? formatDate(ap.last_checked_at) : 'Nunca',
      status:          ap.is_online === null ? 'unknown' : (ap.is_online ? 'online' : 'offline')
    }));

    const online  = list.filter(a => a.is_online === true).length;
    const offline = list.filter(a => a.is_online === false).length;
    const unknown = list.filter(a => a.is_online === null).length;

    const success = req.query.success ? 'Ponto de acesso adicionado com sucesso.' : null;
    const error   = req.query.error   ? decodeURIComponent(String(req.query.error)) : null;

    res.render('admin/access-points', {
      aps: list, online, offline, unknown,
      page: 'access-points',
      pageObj: 'access-points',
      error, success
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar APs: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.saveAccessPoint = async (req, res) => {
  const { name, ip_address, location } = req.body;
  try {
    if (!name || !name.trim()) {
      return res.redirect('/admin/access-points?error=Nome+obrigatorio');
    }
    if (!ip_address || !isValidIPv4(ip_address.trim())) {
      return res.redirect('/admin/access-points?error=IP+invalido');
    }

    await AccessPoint.create({
      name:       name.trim(),
      ip_address: ip_address.trim(),
      location:   location && location.trim() ? location.trim() : null
    });

    logger.info(`[Admin] AP adicionado: ${name.trim()} (${ip_address.trim()})`);
    audit('ap.add', { name: name.trim(), ip: ip_address.trim(), adminIp: req.ip });
    res.redirect('/admin/access-points?success=1');
  } catch (err) {
    logger.error(`[Admin] Erro ao salvar AP: ${err.message}`);
    res.redirect('/admin/access-points?error=Erro+ao+salvar');
  }
};

exports.deleteAccessPoint = async (req, res) => {
  try {
    const ap = await AccessPoint.findByPk(req.params.id);
    if (ap) {
      logger.info(`[Admin] AP removido: ${ap.name} (${ap.ip_address})`);
      audit('ap.delete', { name: ap.name, ip: ap.ip_address, adminIp: req.ip });
      await ApPingHistory.destroy({ where: { ap_id: ap.id } });
      await ap.destroy();
    }
    res.redirect('/admin/access-points');
  } catch (err) {
    logger.error(`[Admin] Erro ao excluir AP: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.pingAccessPoints = async (req, res) => {
  try {
    const results = await pingAllAccessPoints();
    res.json({ ok: true, results, checked_at: new Date().toISOString() });
  } catch (err) {
    logger.error(`[Admin] Erro ao pingar APs: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
};

exports.apHistory = async (req, res) => {
  try {
    const ap = await AccessPoint.findByPk(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Ponto de acesso não encontrado.' });

    const history = await ApPingHistory.findAll({
      where: { ap_id: ap.id },
      order: [['checked_at', 'DESC']],
      limit: 100
    });

    res.json({
      ap: { id: ap.id, name: ap.name, ip_address: ap.ip_address },
      history: history.map(h => ({
        is_online:  h.is_online,
        latency_ms: h.latency_ms,
        checked_at: h.checked_at
      }))
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao buscar histórico do AP: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};
