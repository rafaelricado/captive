const { Op } = require('sequelize');
const { TrafficRanking, WanStat, ClientConnection, DnsEntry } = require('../../models');
const logger = require('../../utils/logger');
const { audit } = require('../../utils/auditLogger');
const { PAGE_SIZE, DISPLAY_TIMEZONE, formatDate, formatBytes, escapeCSV } = require('./helpers');

// ─── Helpers DNS ──────────────────────────────────────────────────────────────

async function buildDnsMap() {
  const rows = await DnsEntry.findAll({ raw: true });
  const map  = {};
  for (const r of rows) {
    if (r.ip_address && !map[r.ip_address]) map[r.ip_address] = r.domain;
  }
  return map;
}

function resolveLabel(ip, dnsMap) {
  if (!ip) return ip;
  const domain = dnsMap[ip];
  if (!domain) return ip;
  const parts = domain.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : domain;
}

// ─── Helpers WAN ──────────────────────────────────────────────────────────────

function padZ(n) { return String(n).padStart(2, '0'); }

function aggregateWanRows(rows) {
  const map = {};
  for (const r of rows) {
    const key = r.interface_name;
    if (!map[key]) {
      map[key] = {
        interface_name:  key,
        tx_total:        0,
        rx_total:        0,
        is_up:           r.is_up,
        is_active_route: r.is_active_route,
        router_name:     r.router_name || '—',
        latest_at:       r.recorded_at
      };
    }
    map[key].tx_total += Number(r.tx_bytes) || 0;
    map[key].rx_total += Number(r.rx_bytes) || 0;
  }
  return Object.values(map).sort((a, b) => a.interface_name.localeCompare(b.interface_name));
}

function buildWanChart(rows) {
  const map = {};
  for (const r of rows) {
    const d = new Date(r.recorded_at);
    const h = `${d.getFullYear()}-${padZ(d.getMonth()+1)}-${padZ(d.getDate())} ${padZ(d.getHours())}:00`;
    const k = `${h}|${r.interface_name}`;
    if (!map[k]) map[k] = { hour: h, iface: r.interface_name, tx: 0, rx: 0 };
    map[k].tx += Number(r.tx_bytes) || 0;
    map[k].rx += Number(r.rx_bytes) || 0;
  }
  const entries = Object.values(map);
  const hours   = [...new Set(entries.map(e => e.hour))].sort();
  const ifaces  = [...new Set(entries.map(e => e.iface))].sort();
  const COLORS  = [['#0d4e8b','#60a5fa'], ['#15803d','#4ade80']];
  const datasets = [];
  ifaces.forEach((iface, i) => {
    const [cRx, cTx] = COLORS[i] || ['#888','#aaa'];
    datasets.push({
      label: `${iface} ↓RX`,
      data: hours.map(h => { const e = map[`${h}|${iface}`]; return e ? +(e.rx/1024/1024).toFixed(2) : 0; }),
      borderColor: cRx, backgroundColor: cRx + '25', fill: true, tension: 0.3, borderWidth: 2
    });
    datasets.push({
      label: `${iface} ↑TX`,
      data: hours.map(h => { const e = map[`${h}|${iface}`]; return e ? +(e.tx/1024/1024).toFixed(2) : 0; }),
      borderColor: cTx, backgroundColor: 'transparent', fill: false, tension: 0.3, borderWidth: 1.5, borderDash: [5,3]
    });
  });
  return { labels: hours.map(h => h.slice(11,16)), datasets };
}

// ─── Controllers ──────────────────────────────────────────────────────────────

exports.traffic = async (req, res) => {
  try {
    const latest = await TrafficRanking.max('recorded_at');
    let clients = [], updatedAt = null;

    if (latest) {
      const rows = await TrafficRanking.findAll({
        where: { recorded_at: latest },
        order: [['bytes_down', 'DESC']],
        limit: 200
      });
      updatedAt = formatDate(latest);
      clients = rows.map(r => ({
        ip_address:  r.ip_address,
        hostname:    r.hostname    || '—',
        mac_address: r.mac_address || '—',
        bytes_up:    formatBytes(r.bytes_up),
        bytes_down:  formatBytes(r.bytes_down),
        total:       formatBytes(Number(r.bytes_up) + Number(r.bytes_down)),
        router_name: r.router_name || '—'
      }));
    }

    res.render('admin/traffic', { clients, updatedAt, page: 'traffic', pageObj: 'traffic' });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar tráfego: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.exportTraffic = async (req, res) => {
  try {
    const latest = await TrafficRanking.max('recorded_at');
    const rows   = latest ? await TrafficRanking.findAll({
      where: { recorded_at: latest },
      order: [['bytes_down', 'DESC']],
      limit: 200
    }) : [];

    const header = 'IP,Hostname,MAC,Upload,Download,Total,Roteador';
    const lines  = rows.map(r => [
      r.ip_address, r.hostname || '', r.mac_address || '',
      formatBytes(r.bytes_up), formatBytes(r.bytes_down),
      formatBytes(Number(r.bytes_up) + Number(r.bytes_down)),
      r.router_name || ''
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trafego_${date}.csv"`);
    audit('traffic.export', { count: rows.length, ip: req.ip });
    res.send('\uFEFF' + header + '\n' + lines.join('\n'));
  } catch (err) {
    logger.error(`[Admin] Erro ao exportar tráfego: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.wan = async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows  = await WanStat.findAll({
      where: { recorded_at: { [Op.gte]: since } },
      order: [['recorded_at', 'DESC']],
      raw: true
    });

    const aggregated = aggregateWanRows(rows);
    const latestTs   = aggregated.reduce((max, r) => (!max || r.latest_at > max ? r.latest_at : max), null);

    const stats = aggregated.map(r => ({
      interface_name:  r.interface_name,
      tx:              formatBytes(r.tx_total),
      rx:              formatBytes(r.rx_total),
      is_up:           r.is_up,
      is_active_route: r.is_active_route,
      router_name:     r.router_name,
      recorded_at:     formatDate(r.latest_at)
    }));

    const chartData = buildWanChart(rows);
    const history   = rows.slice(0, 40).map(r => ({
      interface_name:  r.interface_name,
      tx:              formatBytes(Number(r.tx_bytes) || 0),
      rx:              formatBytes(Number(r.rx_bytes) || 0),
      is_up:           r.is_up,
      is_active_route: r.is_active_route,
      recorded_at:     formatDate(r.recorded_at)
    }));

    res.render('admin/wan', {
      stats, chartData, history,
      updatedAt: latestTs ? formatDate(latestTs) : null,
      page: 'wan', pageObj: 'wan'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar WAN: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.connections = async (req, res) => {
  try {
    const latest = await ClientConnection.max('recorded_at');
    let connections = [], updatedAt = null;

    if (latest) {
      const [rows, dnsMap] = await Promise.all([
        ClientConnection.findAll({ where: { recorded_at: latest }, order: [['bytes_orig', 'DESC']], limit: 200 }),
        buildDnsMap()
      ]);
      updatedAt   = formatDate(latest);
      connections = rows.map(r => ({
        src_ip:      r.src_ip,
        dst_ip:      r.dst_ip,
        dst_label:   resolveLabel(r.dst_ip, dnsMap),
        dst_port:    r.dst_port,
        bytes_orig:  formatBytes(r.bytes_orig),
        bytes_reply: formatBytes(r.bytes_reply),
        router_name: r.router_name || '—'
      }));
    }

    res.render('admin/connections', { connections, updatedAt, page: 'connections', pageObj: 'connections' });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar conexões: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.dns = async (req, res) => {
  try {
    const page   = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const q      = (req.query.q || '').trim();

    const where = q ? {
      [Op.or]: [
        { domain:     { [Op.iLike]: `%${q}%` } },
        { ip_address: { [Op.iLike]: `%${q}%` } }
      ]
    } : {};

    const { count, rows } = await DnsEntry.findAndCountAll({
      where,
      order: [['domain', 'ASC']],
      limit: PAGE_SIZE,
      offset
    });

    const latest = await DnsEntry.max('recorded_at');

    res.render('admin/dns', {
      entries: rows, q, page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total: count,
      pageLabel: page + 1,
      updatedAt: latest ? formatDate(latest) : null,
      pageObj: 'dns'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar DNS: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.trafficData = async (req, res) => {
  try {
    const latest = await TrafficRanking.max('recorded_at');
    let clients = [], updatedAt = null;
    if (latest) {
      const rows = await TrafficRanking.findAll({
        where: { recorded_at: latest }, order: [['bytes_down', 'DESC']], limit: 200
      });
      updatedAt = formatDate(latest);
      clients   = rows.map(r => ({
        ip_address:  r.ip_address,
        hostname:    r.hostname    || '—',
        mac_address: r.mac_address || '—',
        bytes_up:    formatBytes(r.bytes_up),
        bytes_down:  formatBytes(r.bytes_down),
        total:       formatBytes(Number(r.bytes_up) + Number(r.bytes_down)),
        router_name: r.router_name || '—'
      }));
    }
    res.json({ clients, updatedAt });
  } catch (err) {
    logger.error(`[Admin] Erro em trafficData: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

exports.wanData = async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows  = await WanStat.findAll({
      where: { recorded_at: { [Op.gte]: since } },
      order: [['recorded_at', 'DESC']],
      raw: true
    });
    const aggregated = aggregateWanRows(rows);
    const latestTs   = aggregated.reduce((max, r) => (!max || r.latest_at > max ? r.latest_at : max), null);
    const stats      = aggregated.map(r => ({
      interface_name:  r.interface_name,
      tx:              formatBytes(r.tx_total),
      rx:              formatBytes(r.rx_total),
      is_up:           r.is_up,
      is_active_route: r.is_active_route,
      router_name:     r.router_name,
      recorded_at:     formatDate(r.latest_at)
    }));
    const chartData = buildWanChart(rows);
    const history   = rows.slice(0, 40).map(r => ({
      interface_name:  r.interface_name,
      tx:              formatBytes(Number(r.tx_bytes) || 0),
      rx:              formatBytes(Number(r.rx_bytes) || 0),
      is_up:           r.is_up,
      is_active_route: r.is_active_route,
      recorded_at:     formatDate(r.recorded_at)
    }));
    res.json({ stats, chartData, history, updatedAt: latestTs ? formatDate(latestTs) : null });
  } catch (err) {
    logger.error(`[Admin] Erro em wanData: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

exports.connectionsData = async (req, res) => {
  try {
    const latest = await ClientConnection.max('recorded_at');
    let connections = [], updatedAt = null;
    if (latest) {
      const [rows, dnsMap] = await Promise.all([
        ClientConnection.findAll({ where: { recorded_at: latest }, order: [['bytes_orig', 'DESC']], limit: 200 }),
        buildDnsMap()
      ]);
      updatedAt   = formatDate(latest);
      connections = rows.map(r => ({
        src_ip:      r.src_ip,
        dst_ip:      r.dst_ip,
        dst_label:   resolveLabel(r.dst_ip, dnsMap),
        dst_port:    r.dst_port,
        bytes_orig:  formatBytes(r.bytes_orig),
        bytes_reply: formatBytes(r.bytes_reply),
        router_name: r.router_name || '—'
      }));
    }
    res.json({ connections, updatedAt });
  } catch (err) {
    logger.error(`[Admin] Erro em connectionsData: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};
