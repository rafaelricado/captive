const { Op } = require('sequelize');
const { SecurityEvent, sequelize } = require('../../models');
const logger = require('../../utils/logger');
const { audit } = require('../../utils/auditLogger');
const { DISPLAY_TIMEZONE, formatDate, escapeCSV } = require('./helpers');
const securityCountCache = require('../../utils/securityCountCache');

const SECURITY_RETENTION_DAYS = 30;
const VALID_EVENT_TYPES = ['brute_force', 'port_scan', 'traffic_anomaly'];
const VALID_SEVERITIES  = ['low', 'medium', 'high'];
const VALID_PERIODS     = ['24h', '7d'];
const IP_FILTER_RE      = /^[\d.a-fA-F:]{1,45}$/;
const UUID_RE           = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatEventType(type) {
  const map = { brute_force: 'Força Bruta', port_scan: 'Varredura de Portas', traffic_anomaly: 'Anomalia de Tráfego' };
  return map[type] || type;
}

function formatSeverity(s) {
  return { low: 'Baixa', medium: 'Média', high: 'Alta' }[s] || s;
}

function summarizeDetails(details) {
  if (!details) return '—';
  if (details.subtype === 'attempt')          return `Tentativa de login: ${details.reason || ''}`;
  if (details.subtype === 'register_attempt') return `Tentativa de cadastro: ${details.reason || ''}`;
  if (details.subtype === 'register_flood')   return `${details.attempt_count} cadastros repetidos em ${details.window_minutes || '?'} min`;
  if (details.subtype === 'dns_tunneling')    return `${details.dns_count} queries DNS em ${details.window_minutes || '?'} min`;
  if (details.subtype === 'mac_spoofing')     return `${details.mac_count} MACs distintos: ${(details.macs || []).join(', ')}`;
  if (details.subtype === 'correlation')      return `Múltiplos ataques: ${(details.event_types || []).join(', ')}`;
  if (details.attempt_count)  return `${details.attempt_count} tentativas em ${details.window_minutes || '?'} min`;
  if (details.distinct_ports) return `${details.distinct_ports} portas distintas em ${details.window_minutes || '?'} min`;
  if (details.bytes_down_mb)  return `${details.bytes_down_mb} MB baixados (${details.stddev_factor || '?'}× desvio padrão)`;
  return JSON.stringify(details).slice(0, 80);
}

function buildSecurityList(events) {
  return events.map(e => ({
    id:               e.id,
    event_type:       e.event_type,
    event_type_label: formatEventType(e.event_type),
    severity:         e.severity,
    severity_label:   formatSeverity(e.severity),
    src_ip:           e.src_ip,
    details_summary:  summarizeDetails(e.details),
    acknowledged:     e.acknowledged,
    detected_at:      formatDate(e.detected_at)
  }));
}

function parseSecurityFilters(query) {
  return {
    type:     VALID_EVENT_TYPES.includes(query.type)    ? query.type     : '',
    severity: VALID_SEVERITIES.includes(query.severity) ? query.severity : '',
    ip:       IP_FILTER_RE.test(query.ip || '')         ? query.ip       : '',
    period:   VALID_PERIODS.includes(query.period)      ? query.period   : ''
  };
}

async function fetchSecurityEvents(filters = {}) {
  const days  = filters.period === '24h' ? 1 : SECURITY_RETENTION_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const where = {
    detected_at: { [Op.gte]: since },
    [Op.and]: [
      sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
      sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
    ]
  };
  if (filters.type)     where.event_type = filters.type;
  if (filters.severity) where.severity   = filters.severity;
  if (filters.ip)       where.src_ip     = filters.ip;

  return SecurityEvent.findAll({ where, order: [['detected_at', 'DESC']], limit: 500 });
}

async function buildSecurityChart() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows  = await SecurityEvent.findAll({
    attributes: [
      [sequelize.fn('DATE', sequelize.fn('timezone', DISPLAY_TIMEZONE, sequelize.col('detected_at'))), 'day'],
      'event_type',
      [sequelize.fn('COUNT', sequelize.col('id')), 'total']
    ],
    where: {
      detected_at: { [Op.gte]: since },
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
      ]
    },
    group: [
      sequelize.fn('DATE', sequelize.fn('timezone', DISPLAY_TIMEZONE, sequelize.col('detected_at'))),
      'event_type'
    ],
    order: [[sequelize.fn('DATE', sequelize.fn('timezone', DISPLAY_TIMEZONE, sequelize.col('detected_at'))), 'ASC']],
    raw: true
  });

  const labels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    labels.push(d.toLocaleDateString('pt-BR', { timeZone: DISPLAY_TIMEZONE, day: '2-digit', month: '2-digit' }));
  }

  const types    = ['brute_force', 'port_scan', 'traffic_anomaly'];
  const datasets = {};
  types.forEach(t => { datasets[t] = new Array(7).fill(0); });

  rows.forEach(r => {
    const dayStr = new Date(r.day + 'T12:00:00Z').toLocaleDateString('pt-BR', { timeZone: DISPLAY_TIMEZONE, day: '2-digit', month: '2-digit' });
    const idx    = labels.indexOf(dayStr);
    if (idx !== -1 && datasets[r.event_type]) {
      datasets[r.event_type][idx] = Number(r.total);
    }
  });

  return { labels, datasets };
}

async function buildSecurityHourlyChart() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows  = await SecurityEvent.findAll({
    attributes: ['event_type', 'detected_at'],
    where: {
      detected_at: { [Op.gte]: since },
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
      ]
    },
    raw: true
  });

  const nowHour  = Math.floor(Date.now() / 3600000) * 3600000;
  const labels   = [];
  const slotKeys = [];
  for (let i = 23; i >= 0; i--) {
    const slotStart = new Date(nowHour - i * 3600000);
    labels.push(slotStart.toLocaleTimeString('pt-BR', { timeZone: DISPLAY_TIMEZONE, hour: '2-digit', minute: '2-digit' }));
    slotKeys.push(slotStart.toISOString().slice(0, 13));
  }

  const types    = ['brute_force', 'port_scan', 'traffic_anomaly'];
  const datasets = {};
  types.forEach(t => { datasets[t] = new Array(24).fill(0); });

  rows.forEach(r => {
    const key = new Date(Math.floor(new Date(r.detected_at).getTime() / 3600000) * 3600000).toISOString().slice(0, 13);
    const idx = slotKeys.indexOf(key);
    if (idx !== -1 && datasets[r.event_type]) datasets[r.event_type][idx]++;
  });

  return { labels, datasets };
}

exports.security = async (req, res) => {
  try {
    const filters = parseSecurityFilters(req.query);
    const qs      = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString();
    const [events, chartData, hourlyChart] = await Promise.all([
      fetchSecurityEvents(filters), buildSecurityChart(), buildSecurityHourlyChart()
    ]);
    const list                = buildSecurityList(events);
    const unacknowledgedCount = list.filter(e => !e.acknowledged).length;
    const counts = { brute_force: 0, port_scan: 0, traffic_anomaly: 0 };
    list.forEach(e => { if (counts[e.event_type] !== undefined) counts[e.event_type]++; });

    res.render('admin/security', {
      events: list, counts, unacknowledgedCount, chartData, hourlyChart,
      filters, queryString: qs,
      page: 'security', pageObj: 'security',
      csrfToken: res.locals.csrfToken
    });
  } catch (err) {
    logger.error(`[Admin] Erro na página de segurança: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.securityData = async (req, res) => {
  try {
    const filters = parseSecurityFilters(req.query);
    const [events, chartData, hourlyChart] = await Promise.all([
      fetchSecurityEvents(filters), buildSecurityChart(), buildSecurityHourlyChart()
    ]);
    const list                = buildSecurityList(events);
    const unacknowledgedCount = list.filter(e => !e.acknowledged).length;
    const counts = { brute_force: 0, port_scan: 0, traffic_anomaly: 0 };
    list.forEach(e => { if (counts[e.event_type] !== undefined) counts[e.event_type]++; });
    res.json({ events: list, counts, unacknowledgedCount, chartData, hourlyChart });
  } catch (err) {
    logger.error(`[Admin] Erro em securityData: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

exports.securityExport = async (req, res) => {
  try {
    const filters = parseSecurityFilters(req.query);
    const events  = await fetchSecurityEvents(filters);
    const list    = buildSecurityList(events);

    const header = 'Detectado em,Tipo,Severidade,IP Origem,Detalhes,Status';
    const rows   = list.map(e => [
      e.detected_at, e.event_type_label, e.severity_label,
      e.src_ip, e.details_summary, e.acknowledged ? 'Reconhecido' : 'Pendente'
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="seguranca_${date}.csv"`);
    audit('security.export', { count: list.length, ip: req.ip });
    res.send('\uFEFF' + header + '\n' + rows.join('\n'));
  } catch (err) {
    logger.error(`[Admin] Erro ao exportar segurança: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.acknowledgeSecurityEvent = async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.redirect('/admin/security');
  try {
    const event = await SecurityEvent.findByPk(req.params.id);
    if (!event) return res.redirect('/admin/security');
    event.acknowledged = true;
    await event.save();
    securityCountCache.invalidate();
    logger.info(`[Admin] Evento de segurança reconhecido: ${event.id} (${event.event_type} / ${event.src_ip})`);
    audit('security.acknowledge', { eventId: event.id, eventType: event.event_type, srcIp: event.src_ip, ip: req.ip });
    res.redirect('/admin/security');
  } catch (err) {
    logger.error(`[Admin] Erro ao reconhecer evento de segurança: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.acknowledgeAllSecurityEvents = async (req, res) => {
  try {
    const filters    = parseSecurityFilters(req.body || {});
    const hasFilters = filters.type || filters.severity || filters.ip || filters.period;

    let where = {
      acknowledged: false,
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
      ]
    };

    if (hasFilters) {
      const days  = filters.period === '24h' ? 1 : SECURITY_RETENTION_DAYS;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      where.detected_at = { [Op.gte]: since };
      if (filters.type)     where.event_type = filters.type;
      if (filters.severity) where.severity   = filters.severity;
      if (filters.ip)       where.src_ip     = filters.ip;
    }

    const [count] = await SecurityEvent.update({ acknowledged: true }, { where });
    securityCountCache.invalidate();
    logger.info(`[Admin] ${count} evento(s) de segurança reconhecidos em massa.`);
    audit('security.acknowledge_all', { count, filters: hasFilters ? filters : 'all', ip: req.ip });

    const qs = hasFilters ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString() : '';
    res.redirect('/admin/security' + qs);
  } catch (err) {
    logger.error(`[Admin] Erro ao reconhecer todos os eventos: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};
