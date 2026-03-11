const { Op, fn, col } = require('sequelize');
const { DeviceHistory, TrafficRanking } = require('../../../models');
const logger = require('../../../utils/logger');
const { audit } = require('../../../utils/auditLogger');
const { PAGE_SIZE, DISPLAY_TIMEZONE, MAC_RE_STRICT, formatDate, escapeCSV } = require('../../../controllers/admin/helpers');

exports.devices = async (req, res) => {
  try {
    const page   = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const q      = (req.query.q || '').trim();

    const where = q ? {
      [Op.or]: [
        { mac_address: { [Op.iLike]: `%${q}%` } },
        { ip_address:  { [Op.iLike]: `%${q}%` } },
        { hostname:    { [Op.iLike]: `%${q}%` } }
      ]
    } : {};

    const latestTraffic = await TrafficRanking.max('recorded_at');
    const onlineMacs    = new Set(
      latestTraffic
        ? (await TrafficRanking.findAll({
            where: { recorded_at: latestTraffic },
            attributes: ['mac_address'],
            raw: true
          })).map(r => r.mac_address).filter(Boolean)
        : []
    );

    const [devices, total] = await Promise.all([
      DeviceHistory.findAll({
        attributes: [
          'mac_address',
          [fn('MAX', col('hostname')),                          'hostname'],
          [fn('COUNT', fn('DISTINCT', col('ip_address'))),      'ip_count'],
          [fn('MIN', col('first_seen')),                        'first_seen'],
          [fn('MAX', col('last_seen')),                         'last_seen'],
          [fn('MAX', col('router_name')),                       'router_name']
        ],
        where,
        group: ['mac_address'],
        order: [[fn('MAX', col('last_seen')), 'DESC']],
        limit: PAGE_SIZE,
        offset,
        raw: true
      }),
      DeviceHistory.count({ distinct: true, col: 'mac_address', where })
    ]);

    res.render('admin/devices', {
      devices: devices.map(d => ({
        mac_address: d.mac_address,
        hostname:    d.hostname    || '—',
        ip_count:    Number(d.ip_count),
        first_seen:  formatDate(d.first_seen),
        last_seen:   formatDate(d.last_seen),
        router_name: d.router_name || '—',
        online:      onlineMacs.has(d.mac_address)
      })),
      q, page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      pageLabel: page + 1,
      pageObj: 'devices'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar dispositivos: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.exportDevices = async (req, res) => {
  try {
    const rows = await DeviceHistory.findAll({
      attributes: [
        'mac_address',
        [fn('MAX', col('hostname')),                     'hostname'],
        [fn('COUNT', fn('DISTINCT', col('ip_address'))), 'ip_count'],
        [fn('MIN', col('first_seen')),                   'first_seen'],
        [fn('MAX', col('last_seen')),                    'last_seen'],
        [fn('MAX', col('router_name')),                  'router_name']
      ],
      group: ['mac_address'],
      order: [[fn('MAX', col('last_seen')), 'DESC']],
      raw: true
    });

    const header = 'MAC,Hostname,IPs,Primeiro Acesso,Ultimo Acesso,Roteador';
    const lines  = rows.map(d => [
      d.mac_address, d.hostname || '',
      Number(d.ip_count),
      new Date(d.first_seen).toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE }),
      new Date(d.last_seen).toLocaleString('pt-BR',  { timeZone: DISPLAY_TIMEZONE }),
      d.router_name || ''
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dispositivos_${date}.csv"`);
    audit('devices.export', { count: rows.length, ip: req.ip });
    res.send('\uFEFF' + header + '\n' + lines.join('\n'));
  } catch (err) {
    logger.error(`[Admin] Erro ao exportar dispositivos: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.deviceDetail = async (req, res) => {
  try {
    const mac = (req.params.mac || '').trim().toUpperCase();
    if (!MAC_RE_STRICT.test(mac)) return res.status(400).send('MAC inválido.');

    const entries = await DeviceHistory.findAll({
      where: { mac_address: mac },
      order: [['last_seen', 'DESC']],
      raw: true
    });

    if (entries.length === 0) return res.status(404).send('Dispositivo não encontrado.');

    const hostname = entries.find(e => e.hostname)?.hostname || mac;

    res.render('admin/device_detail', {
      mac,
      hostname,
      entries: entries.map(e => ({
        ip_address:  e.ip_address,
        hostname:    e.hostname    || '—',
        first_seen:  formatDate(e.first_seen),
        last_seen:   formatDate(e.last_seen),
        router_name: e.router_name || '—'
      })),
      pageObj: 'devices'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao detalhar dispositivo: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};
