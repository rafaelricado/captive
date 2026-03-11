const { Op, fn, col } = require('sequelize');
const { ManagedIp, TrafficRanking, DeviceHistory, ClientConnection, sequelize } = require('../../../models');
const mikrotikService = require('../services/mikrotikService');
const { isValidIPv4 } = require('../services/pingService');
const ouiLookup = require('../../../utils/ouiLookup');
const logger = require('../../../utils/logger');
const { PAGE_SIZE, MAC_RE_STRICT, formatDate, formatBytes } = require('../../../controllers/admin/helpers');

exports.managedIps = async (req, res) => {
  try {
    const page   = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const q      = (req.query.q || '').trim();

    const where = q ? {
      [Op.or]: [
        { ip_address:  { [Op.iLike]: `%${q}%` } },
        { mac_address: { [Op.iLike]: `%${q}%` } },
        { hostname:    { [Op.iLike]: `%${q}%` } },
        { location:    { [Op.iLike]: `%${q}%` } },
        { department:  { [Op.iLike]: `%${q}%` } },
        { responsible: { [Op.iLike]: `%${q}%` } }
      ]
    } : {};

    const [ips, total] = await Promise.all([
      ManagedIp.findAll({ where, order: [[sequelize.literal('ip_address::inet'), 'ASC']], limit: PAGE_SIZE, offset, raw: true }),
      ManagedIp.count({ where })
    ]);

    const ipAddresses = ips.map(r => r.ip_address);
    const cutoff30    = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [trafficRows, deviceRows] = ipAddresses.length > 0 ? await Promise.all([
      TrafficRanking.findAll({
        attributes: [
          'ip_address',
          [fn('SUM', col('bytes_up')),    'total_up'],
          [fn('SUM', col('bytes_down')),  'total_down'],
          [fn('MAX', col('recorded_at')), 'last_seen']
        ],
        where: { ip_address: { [Op.in]: ipAddresses }, recorded_at: { [Op.gte]: cutoff30 } },
        group: ['ip_address'],
        raw: true
      }),
      DeviceHistory.findAll({
        attributes: ['ip_address', [fn('MAX', col('last_seen')), 'last_seen_dev']],
        where: { ip_address: { [Op.in]: ipAddresses } },
        group: ['ip_address'],
        raw: true
      })
    ]) : [[], []];

    const trafficMap = Object.fromEntries(trafficRows.map(r => [r.ip_address, r]));
    const deviceMap  = Object.fromEntries(deviceRows.map(r => [r.ip_address, r]));

    res.render('admin/managed-ips', {
      ips: ips.map(ip => {
        const tr         = trafficMap[ip.ip_address] || {};
        const dv         = deviceMap[ip.ip_address]  || {};
        const lastSeenTs = tr.last_seen || dv.last_seen_dev;
        return {
          ...ip,
          total_up:      formatBytes(tr.total_up   || 0),
          total_down:    formatBytes(tr.total_down  || 0),
          total_traffic: formatBytes((Number(tr.total_up) || 0) + (Number(tr.total_down) || 0)),
          last_seen:     lastSeenTs ? formatDate(lastSeenTs) : '—'
        };
      }),
      q, page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      pageLabel: page + 1,
      pageObj: 'managed-ips'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar IPs gerenciados: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.managedIpDetail = async (req, res) => {
  try {
    const { id }    = req.params;
    const managed   = await ManagedIp.findByPk(id, { raw: true });
    if (!managed) return res.status(404).send('IP não encontrado.');

    const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [trafficHistory, deviceEntries, connections] = await Promise.all([
      TrafficRanking.findAll({
        where: { ip_address: managed.ip_address, recorded_at: { [Op.gte]: cutoff30 } },
        order: [['recorded_at', 'DESC']],
        limit: 200,
        raw: true
      }),
      DeviceHistory.findAll({
        where: { ip_address: managed.ip_address },
        order: [['last_seen', 'DESC']],
        raw: true
      }),
      ClientConnection.findAll({
        where: { src_ip: managed.ip_address },
        order: [['recorded_at', 'DESC']],
        limit: 50,
        raw: true
      })
    ]);

    res.render('admin/managed-ip-detail', {
      managed,
      trafficHistory: trafficHistory.map(r => ({
        recorded_at: formatDate(r.recorded_at),
        hostname:    r.hostname    || '—',
        mac_address: r.mac_address || '—',
        bytes_up:    formatBytes(r.bytes_up),
        bytes_down:  formatBytes(r.bytes_down),
        total:       formatBytes(Number(r.bytes_up) + Number(r.bytes_down))
      })),
      deviceEntries: deviceEntries.map(e => ({
        mac_address: e.mac_address,
        hostname:    e.hostname    || '—',
        first_seen:  formatDate(e.first_seen),
        last_seen:   formatDate(e.last_seen),
        router_name: e.router_name || '—'
      })),
      connections: connections.map(c => ({
        src_ip:      c.src_ip,
        dst_ip:      c.dst_ip   || '—',
        dst_port:    c.dst_port ?? '—',
        bytes_orig:  formatBytes(c.bytes_orig),
        bytes_reply: formatBytes(c.bytes_reply),
        recorded_at: formatDate(c.recorded_at)
      })),
      pageObj: 'managed-ips'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao detalhar IP gerenciado: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.saveManagedIp = async (req, res) => {
  try {
    const { id, ip_address, mac_address, hostname, location, department, responsible, notes, is_active } = req.body;

    if (!ip_address || !isValidIPv4(ip_address.trim())) {
      return res.redirect('/admin/managed-ips?toast=' + encodeURIComponent('IP inválido.') + '&toastType=error');
    }

    const mac = mac_address ? mac_address.trim().toUpperCase() : null;
    if (mac && !MAC_RE_STRICT.test(mac)) {
      return res.redirect('/admin/managed-ips?toast=' + encodeURIComponent('Endereço MAC inválido.') + '&toastType=error');
    }

    const deviceTypeBody = req.body.device_type || null;
    let vendor      = req.body.vendor ? req.body.vendor.trim().substring(0, 150) : null;
    let device_type = deviceTypeBody && deviceTypeBody !== 'unknown' ? deviceTypeBody : null;

    if (mac && !device_type) {
      const identified = await ouiLookup.identify(mac);
      if (identified.vendor)      vendor      = identified.vendor;
      if (identified.device_type) device_type = identified.device_type;
    }

    const data = {
      ip_address:  ip_address.trim(),
      mac_address: mac || null,
      hostname:    hostname    ? hostname.trim().substring(0, 255)    : null,
      location:    location    ? location.trim().substring(0, 255)    : null,
      department:  department  ? department.trim().substring(0, 100)  : null,
      responsible: responsible ? responsible.trim().substring(0, 100) : null,
      notes:       notes       ? notes.trim()                         : null,
      vendor:      vendor      || null,
      device_type: device_type || 'unknown',
      is_active:   is_active === 'true' || is_active === '1' || is_active === 'on'
    };

    if (id) {
      await ManagedIp.update(data, { where: { id } });
      logger.info(`[Admin] IP gerenciado atualizado: ${data.ip_address}`);
      return res.redirect('/admin/managed-ips/' + id + '?toast=' + encodeURIComponent('Salvo com sucesso.') + '&toastType=success');
    } else {
      const created = await ManagedIp.create(data);
      logger.info(`[Admin] IP gerenciado criado: ${data.ip_address}`);
      return res.redirect('/admin/managed-ips/' + created.id + '?toast=' + encodeURIComponent('IP cadastrado com sucesso.') + '&toastType=success');
    }
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.redirect('/admin/managed-ips?toast=' + encodeURIComponent('Este IP já está cadastrado.') + '&toastType=error');
    }
    logger.error(`[Admin] Erro ao salvar IP gerenciado: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.deleteManagedIp = async (req, res) => {
  try {
    const { id }    = req.params;
    const managed   = await ManagedIp.findByPk(id);
    if (!managed) return res.status(404).send('IP não encontrado.');
    const ip = managed.ip_address;
    await managed.destroy();
    logger.info(`[Admin] IP gerenciado removido: ${ip}`);
    res.redirect('/admin/managed-ips?toast=' + encodeURIComponent('IP removido.') + '&toastType=success');
  } catch (err) {
    logger.error(`[Admin] Erro ao remover IP gerenciado: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.arpTable = async (req, res) => {
  try {
    const [arpEntries, leases] = await Promise.all([
      mikrotikService.getArpTable(),
      mikrotikService.getDhcpLeases()
    ]);

    if (!arpEntries) {
      return res.status(503).json({ error: 'Não foi possível conectar ao Mikrotik.' });
    }

    const leaseMap = {};
    if (leases) {
      leases.forEach(l => { if (l.address) leaseMap[l.address] = l['host-name'] || null; });
    }

    const managed    = await ManagedIp.findAll({ attributes: ['ip_address'], raw: true });
    const managedSet = new Set(managed.map(m => m.ip_address));

    const entries = arpEntries
      .filter(e =>
        e.address &&
        e['mac-address'] &&
        e.address !== '0.0.0.0' &&
        e.complete  !== 'false' &&
        e.disabled  !== 'true'
      )
      .map(e => ({
        ip:         e.address,
        mac:        e['mac-address'],
        hostname:   leaseMap[e.address] || null,
        interface:  e.interface         || null,
        is_managed: managedSet.has(e.address)
      }))
      .sort((a, b) => {
        const toNum = ip => ip.split('.').reduce((acc, o) => (acc * 256 + parseInt(o, 10)) >>> 0, 0);
        return toNum(a.ip) - toNum(b.ip);
      });

    res.json({ entries });
  } catch (err) {
    logger.error(`[Admin] Erro ao buscar tabela ARP: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

exports.managedIpLive = async (req, res) => {
  try {
    const { id }  = req.params;
    const managed = await ManagedIp.findByPk(id, { raw: true });
    if (!managed) return res.status(404).json({ error: 'IP não encontrado.' });

    const [arpEntries, leases] = await Promise.all([
      mikrotikService.getArpTable(),
      mikrotikService.getDhcpLeases()
    ]);

    const arp   = arpEntries ? arpEntries.find(e => e.address === managed.ip_address) : null;
    const lease = leases     ? leases.find(l => l.address === managed.ip_address)     : null;

    res.json({
      arp: arp ? {
        mac:       arp['mac-address'],
        interface: arp.interface  || null,
        status:    arp.status     || null,
        complete:  arp.complete !== 'false'
      } : null,
      lease: lease ? {
        hostname:      lease['host-name']      || null,
        mac:           lease['mac-address']    || null,
        expires_after: lease['expires-after']  || null,
        server:        lease.server            || null
      } : null
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao buscar dados live do IP: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

exports.syncManagedIp = async (req, res) => {
  try {
    const { id }  = req.params;
    const managed = await ManagedIp.findByPk(id);
    if (!managed) return res.status(404).json({ error: 'IP não encontrado.' });

    const [arpEntries, leases] = await Promise.all([
      mikrotikService.getArpTable(),
      mikrotikService.getDhcpLeases()
    ]);

    if (!arpEntries) {
      return res.status(503).json({ error: 'Sem conexão com Mikrotik.' });
    }

    const arp   = arpEntries.find(e => e.address === managed.ip_address);
    const lease = leases ? leases.find(l => l.address === managed.ip_address) : null;

    if (!arp) {
      return res.json({ ok: false, message: 'IP não encontrado na tabela ARP do Mikrotik.' });
    }

    const updates = {};
    if (arp['mac-address'])          updates.mac_address = arp['mac-address'];
    if (lease && lease['host-name']) updates.hostname    = lease['host-name'];

    const macForId = updates.mac_address || managed.mac_address;
    if (macForId) {
      const identified = await ouiLookup.identify(macForId);
      if (identified.vendor)                    updates.vendor      = identified.vendor;
      if (identified.device_type !== 'unknown') updates.device_type = identified.device_type;
    }

    if (Object.keys(updates).length > 0) {
      await managed.update(updates);
      logger.info(`[Admin] IP gerenciado sincronizado com Mikrotik: ${managed.ip_address}`);
    }

    res.json({ ok: true, updates });
  } catch (err) {
    logger.error(`[Admin] Erro ao sincronizar IP gerenciado: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

exports.identifyManagedIp = async (req, res) => {
  try {
    const { id }  = req.params;
    const managed = await ManagedIp.findByPk(id);
    if (!managed) return res.status(404).json({ error: 'IP não encontrado.' });

    if (!managed.mac_address) {
      return res.json({ ok: false, message: 'Sem MAC cadastrado. Sincronize com o Mikrotik primeiro.' });
    }

    const { vendor, device_type } = await ouiLookup.identify(managed.mac_address);
    const updates = { device_type: device_type || 'unknown' };
    if (vendor) updates.vendor = vendor;

    await managed.update(updates);
    logger.info(`[Admin] Dispositivo identificado: ${managed.ip_address} → ${vendor || 'desconhecido'} (${device_type})`);

    res.json({
      ok:          true,
      vendor:      updates.vendor      || null,
      device_type: updates.device_type,
      label:       ouiLookup.DEVICE_TYPE_LABELS[device_type] || 'Desconhecido'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao identificar dispositivo: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};
