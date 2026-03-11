const { Op, fn, col } = require('sequelize');
const { User, Session, DeviceHistory, WanStat, sequelize } = require('../../models');
const logger = require('../../utils/logger');
const { DISPLAY_TIMEZONE, formatDate, formatBytes, startOfDay, startOfWeek } = require('./helpers');

exports.home = (req, res) => {
  res.render('admin/home', { page: 'home' });
};

exports.dashboard = async (req, res) => {
  try {
    const now = new Date();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [totalUsers, activeSessions, novosHoje, novosSemana, totalDevices, registrosDiaRaw, wan24h, latestWanTime] = await Promise.all([
      User.count(),
      Session.count({ where: { active: true, expires_at: { [Op.gt]: now } } }),
      User.count({ where: { created_at: { [Op.gte]: startOfDay() } } }),
      User.count({ where: { created_at: { [Op.gte]: startOfWeek() } } }),
      DeviceHistory.count({ distinct: true, col: 'mac_address' }),
      User.findAll({
        attributes: [
          [fn('DATE', fn('timezone', DISPLAY_TIMEZONE, col('created_at'))), 'day'],
          [fn('COUNT', col('id')), 'count']
        ],
        where: { created_at: { [Op.gte]: since7d } },
        group: [fn('DATE', fn('timezone', DISPLAY_TIMEZONE, col('created_at')))],
        order: [[fn('DATE', fn('timezone', DISPLAY_TIMEZONE, col('created_at'))), 'ASC']],
        raw: true
      }),
      WanStat.findAll({
        attributes: [
          'interface_name',
          [sequelize.fn('SUM', sequelize.col('tx_bytes')), 'total_tx'],
          [sequelize.fn('SUM', sequelize.col('rx_bytes')), 'total_rx'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'total_records'],
          [sequelize.literal(`SUM(CASE WHEN is_up THEN 1 ELSE 0 END)`), 'up_count']
        ],
        where: { recorded_at: { [Op.gte]: since24h } },
        group: ['interface_name'],
        order: [['interface_name', 'ASC']],
        raw: true
      }),
      WanStat.max('recorded_at')
    ]);

    const wanLatest = latestWanTime
      ? await WanStat.findAll({ where: { recorded_at: latestWanTime }, raw: true })
      : [];

    const wanMap = {};
    wan24h.forEach(r => {
      const total = Number(r.total_records);
      const up    = Number(r.up_count);
      wanMap[r.interface_name] = {
        interface_name:  r.interface_name,
        volume:          formatBytes(Number(r.total_tx) + Number(r.total_rx)),
        uptime:          total > 0 ? Math.round((up / total) * 100) : null,
        is_up:           null,
        is_active_route: null
      };
    });
    wanLatest.forEach(r => {
      if (wanMap[r.interface_name]) {
        wanMap[r.interface_name].is_up           = r.is_up;
        wanMap[r.interface_name].is_active_route = r.is_active_route;
      } else {
        wanMap[r.interface_name] = {
          interface_name:  r.interface_name,
          volume:          '—',
          uptime:          null,
          is_up:           r.is_up,
          is_active_route: r.is_active_route
        };
      }
    });
    if (wanLatest.length > 0) {
      const currentIfaces = new Set(wanLatest.map(r => r.interface_name));
      Object.keys(wanMap).forEach(k => { if (!currentIfaces.has(k)) delete wanMap[k]; });
    }
    const wanCards = Object.values(wanMap);

    const registrosLabels = [];
    const registrosData   = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const label  = d.toLocaleDateString('pt-BR', { timeZone: DISPLAY_TIMEZONE, day: '2-digit', month: '2-digit' });
      const dayStr = d.toLocaleDateString('en-CA', { timeZone: DISPLAY_TIMEZONE });
      const found  = registrosDiaRaw.find(r => r.day === dayStr);
      registrosLabels.push(label);
      registrosData.push(found ? Number(found.count) : 0);
    }

    res.render('admin/dashboard', {
      totalUsers, activeSessions, novosHoje, novosSemana, totalDevices,
      registrosChart: { labels: registrosLabels, data: registrosData },
      wanCards,
      page: 'captive'
    });
  } catch (err) {
    logger.error(`[Admin] Erro no dashboard: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};
