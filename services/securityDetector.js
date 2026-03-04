const axios = require('axios');
const { Op } = require('sequelize');
const { SecurityEvent, ClientConnection, TrafficRanking, Setting, sequelize } = require('../models');
const logger = require('../utils/logger');

const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE || 'America/Sao_Paulo';

// ─── Constantes fixas ──────────────────────────────────────────────────────────
const BRUTE_FORCE_WINDOW_MS = 15 * 60 * 1000; // 15 min
const PORT_SCAN_WINDOW_MS   = 10 * 60 * 1000; // 10 min
const DNS_TUNNEL_WINDOW_MS  = 10 * 60 * 1000; // 10 min
const MAC_SPOOF_WINDOW_MS   = 2 * 60 * 60 * 1000; // 2 h
const DEDUP_WINDOW_MS       = 60 * 60 * 1000; // 1 h
const EVENT_RETENTION_DAYS  = 30;

const WEBHOOK_RETRY_DELAYS = [0, 2000, 5000];

// ─── Labels ───────────────────────────────────────────────────────────────────
const EVENT_TYPE_LABELS = {
  brute_force:     'Força Bruta',
  port_scan:       'Varredura de Portas',
  traffic_anomaly: 'Anomalia de Tráfego'
};
const SEVERITY_LABELS = { low: 'Baixa', medium: 'Média', high: 'Alta' };

// ─── Webhook ──────────────────────────────────────────────────────────────────
async function sendSecurityAlert(event) {
  const webhookUrl = await Setting.get('alert_webhook_url', '');
  if (!webhookUrl) return;

  const typeLabel     = EVENT_TYPE_LABELS[event.event_type] || event.event_type;
  const severityLabel = SEVERITY_LABELS[event.severity]     || event.severity;
  const now = new Date().toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE });
  const msg = `🚨 Ataque detectado: ${typeLabel} | IP: ${event.src_ip} | Severidade: ${severityLabel} | ${now}`;
  const payload = { text: msg, content: msg };

  for (let attempt = 0; attempt < WEBHOOK_RETRY_DELAYS.length; attempt++) {
    if (WEBHOOK_RETRY_DELAYS[attempt] > 0)
      await new Promise(r => setTimeout(r, WEBHOOK_RETRY_DELAYS[attempt]));
    try {
      await axios.post(webhookUrl, payload, { timeout: 5000 });
      logger.info(`[Security] Alerta webhook: ${event.event_type} / ${event.src_ip}`);
      return;
    } catch (err) {
      logger.warn(`[Security] Falha tentativa ${attempt + 1}/${WEBHOOK_RETRY_DELAYS.length} webhook: ${err.message}`);
    }
  }
  logger.error(`[Security] Todas tentativas de webhook falharam: ${event.event_type} / ${event.src_ip}`);
}

// ─── Configurações dinâmicas ──────────────────────────────────────────────────
async function loadSecuritySettings() {
  const [
    whitelist_raw, bf_threshold, ps_threshold,
    reg_threshold, dns_threshold, stddev_factor
  ] = await Promise.all([
    Setting.get('security_ip_whitelist', '[]'),
    Setting.get('security_brute_force_threshold', '5'),
    Setting.get('security_port_scan_threshold', '20'),
    Setting.get('security_register_threshold', '5'),
    Setting.get('security_dns_threshold', '50'),
    Setting.get('security_anomaly_stddev', '3')
  ]);

  let whitelist = [];
  try { whitelist = JSON.parse(whitelist_raw); } catch (_) {}
  if (!Array.isArray(whitelist)) whitelist = [];

  return {
    whitelist,
    bruteForceThreshold: Math.max(1, parseInt(bf_threshold, 10) || 5),
    portScanThreshold:   Math.max(1, parseInt(ps_threshold, 10) || 20),
    registerThreshold:   Math.max(1, parseInt(reg_threshold, 10) || 5),
    dnsThreshold:        Math.max(1, parseInt(dns_threshold, 10) || 50),
    anomalyStddev:       Math.max(1, parseFloat(stddev_factor) || 3)
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isWhitelisted(ip, whitelist) {
  return whitelist.includes(ip);
}

/** Verifica duplicata de evento confirmado (não-attempt) nos últimos 60 min */
async function isDuplicate(event_type, src_ip) {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const existing = await SecurityEvent.findOne({
    where: {
      event_type,
      src_ip,
      detected_at: { [Op.gte]: since },
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
      ]
    }
  });
  return !!existing;
}

// Subtypes válidos para consulta de deduplicação (whitelist para evitar interpolação arbitrária)
const VALID_SUBTYPES = new Set(['register_flood', 'dns_tunneling', 'mac_spoofing', 'correlation']);

/** Verifica duplicata de evento com subtype específico nos últimos 60 min */
async function isDuplicateSubtype(src_ip, subtype) {
  if (!VALID_SUBTYPES.has(subtype)) return false; // rejeita subtypes desconhecidos
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const existing = await SecurityEvent.findOne({
    where: {
      src_ip,
      detected_at: { [Op.gte]: since },
      [Op.and]: [sequelize.literal(`details->>'subtype' = '${subtype}'`)]
    }
  });
  return !!existing;
}

// ─── Detector: Força Bruta ────────────────────────────────────────────────────
async function detectBruteForce({ whitelist, bruteForceThreshold }) {
  const since = new Date(Date.now() - BRUTE_FORCE_WINDOW_MS);

  const rows = await SecurityEvent.findAll({
    attributes: [
      'src_ip',
      [sequelize.fn('COUNT', sequelize.col('id')), 'attempt_count']
    ],
    where: {
      event_type: 'brute_force',
      detected_at: { [Op.gte]: since },
      [Op.and]: [sequelize.literal(`details->>'subtype' = 'attempt'`)]
    },
    group: ['src_ip'],
    having: sequelize.literal(`COUNT(id) >= ${bruteForceThreshold}`),
    raw: true
  });

  for (const row of rows) {
    const src_ip = row.src_ip;
    if (isWhitelisted(src_ip, whitelist)) continue;
    const attempt_count = Number(row.attempt_count);
    if (await isDuplicate('brute_force', src_ip)) continue;

    const severity = attempt_count >= 20 ? 'high' : attempt_count >= 10 ? 'medium' : 'low';
    const event = await SecurityEvent.create({
      event_type: 'brute_force', severity, src_ip,
      details: { attempt_count, window_minutes: BRUTE_FORCE_WINDOW_MS / 60000, threshold: bruteForceThreshold }
    });
    logger.warn(`[Security] Força bruta: ${src_ip} — ${attempt_count} tentativas`);
    sendSecurityAlert(event).catch(err => logger.error(`[Security] Webhook: ${err.message}`));
  }
}

// ─── Detector: Flood de Registro ─────────────────────────────────────────────
async function detectRegisterFlood({ whitelist, registerThreshold }) {
  const since = new Date(Date.now() - BRUTE_FORCE_WINDOW_MS);

  const rows = await SecurityEvent.findAll({
    attributes: [
      'src_ip',
      [sequelize.fn('COUNT', sequelize.col('id')), 'attempt_count']
    ],
    where: {
      event_type: 'brute_force',
      detected_at: { [Op.gte]: since },
      [Op.and]: [sequelize.literal(`details->>'subtype' = 'register_attempt'`)]
    },
    group: ['src_ip'],
    having: sequelize.literal(`COUNT(id) >= ${registerThreshold}`),
    raw: true
  });

  for (const row of rows) {
    const src_ip = row.src_ip;
    if (isWhitelisted(src_ip, whitelist)) continue;
    const attempt_count = Number(row.attempt_count);
    if (await isDuplicateSubtype(src_ip, 'register_flood')) continue;

    const severity = attempt_count >= 20 ? 'high' : attempt_count >= 10 ? 'medium' : 'low';
    const event = await SecurityEvent.create({
      event_type: 'brute_force', severity, src_ip,
      details: { subtype: 'register_flood', attempt_count, window_minutes: BRUTE_FORCE_WINDOW_MS / 60000, threshold: registerThreshold }
    });
    logger.warn(`[Security] Flood de registro: ${src_ip} — ${attempt_count} tentativas de cadastro`);
    sendSecurityAlert(event).catch(err => logger.error(`[Security] Webhook: ${err.message}`));
  }
}

// ─── Detector: Varredura de Portas ───────────────────────────────────────────
async function detectPortScans({ whitelist, portScanThreshold }) {
  const since = new Date(Date.now() - PORT_SCAN_WINDOW_MS);

  const rows = await ClientConnection.findAll({
    attributes: [
      'src_ip',
      [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('dst_port'))), 'distinct_ports']
    ],
    where: {
      recorded_at: { [Op.gte]: since },
      dst_port: { [Op.not]: null }
    },
    group: ['src_ip'],
    having: sequelize.literal(`COUNT(DISTINCT dst_port) >= ${portScanThreshold}`),
    raw: true
  });

  for (const row of rows) {
    const src_ip = row.src_ip;
    if (!src_ip) continue;
    if (isWhitelisted(src_ip, whitelist)) continue;
    const distinct_ports = Number(row.distinct_ports);
    if (await isDuplicate('port_scan', src_ip)) continue;

    const severity = distinct_ports >= 100 ? 'high' : distinct_ports >= 50 ? 'medium' : 'low';
    const event = await SecurityEvent.create({
      event_type: 'port_scan', severity, src_ip,
      details: { distinct_ports, window_minutes: PORT_SCAN_WINDOW_MS / 60000, threshold: portScanThreshold }
    });
    logger.warn(`[Security] Port scan: ${src_ip} — ${distinct_ports} portas distintas`);
    sendSecurityAlert(event).catch(err => logger.error(`[Security] Webhook: ${err.message}`));
  }
}

// ─── Detector: DNS Tunneling ──────────────────────────────────────────────────
async function detectDnsTunneling({ whitelist, dnsThreshold }) {
  const since = new Date(Date.now() - DNS_TUNNEL_WINDOW_MS);

  const rows = await ClientConnection.findAll({
    attributes: [
      'src_ip',
      [sequelize.fn('COUNT', sequelize.col('id')), 'dns_count']
    ],
    where: {
      recorded_at: { [Op.gte]: since },
      dst_port: 53
    },
    group: ['src_ip'],
    having: sequelize.literal(`COUNT(id) >= ${dnsThreshold}`),
    raw: true
  });

  for (const row of rows) {
    const src_ip = row.src_ip;
    if (!src_ip) continue;
    if (isWhitelisted(src_ip, whitelist)) continue;
    const dns_count = Number(row.dns_count);
    if (await isDuplicateSubtype(src_ip, 'dns_tunneling')) continue;

    const severity = dns_count >= 200 ? 'high' : dns_count >= 100 ? 'medium' : 'low';
    const event = await SecurityEvent.create({
      event_type: 'port_scan', severity, src_ip,
      details: { subtype: 'dns_tunneling', dns_count, window_minutes: DNS_TUNNEL_WINDOW_MS / 60000, threshold: dnsThreshold }
    });
    logger.warn(`[Security] DNS tunneling: ${src_ip} — ${dns_count} queries DNS`);
    sendSecurityAlert(event).catch(err => logger.error(`[Security] Webhook: ${err.message}`));
  }
}

// ─── Detector: MAC Spoofing ───────────────────────────────────────────────────
async function detectMacSpoofing({ whitelist }) {
  const since = new Date(Date.now() - MAC_SPOOF_WINDOW_MS);

  const rows = await TrafficRanking.findAll({
    attributes: [
      'ip_address',
      [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('mac_address'))), 'mac_count']
    ],
    where: {
      recorded_at: { [Op.gte]: since },
      mac_address: { [Op.not]: null }
    },
    group: ['ip_address'],
    having: sequelize.literal(`COUNT(DISTINCT mac_address) > 1`),
    raw: true
  });

  for (const row of rows) {
    const src_ip = row.ip_address;
    if (!src_ip) continue;
    if (isWhitelisted(src_ip, whitelist)) continue;
    const mac_count = Number(row.mac_count);
    if (await isDuplicateSubtype(src_ip, 'mac_spoofing')) continue;

    // Lista os MACs distintos para incluir nos detalhes
    const macRows = await TrafficRanking.findAll({
      attributes: ['mac_address'],
      where: { ip_address: src_ip, recorded_at: { [Op.gte]: since }, mac_address: { [Op.not]: null } },
      group: ['mac_address'],
      raw: true
    });
    const macs = macRows.map(r => r.mac_address).filter(Boolean);

    const event = await SecurityEvent.create({
      event_type: 'traffic_anomaly', severity: 'high', src_ip,
      details: { subtype: 'mac_spoofing', mac_count, macs, window_hours: MAC_SPOOF_WINDOW_MS / 3600000 }
    });
    logger.warn(`[Security] MAC Spoofing: ${src_ip} — ${mac_count} MACs distintos`);
    sendSecurityAlert(event).catch(err => logger.error(`[Security] Webhook: ${err.message}`));
  }
}

// ─── Detector: Anomalia de Tráfego ───────────────────────────────────────────
async function detectTrafficAnomalies({ whitelist, anomalyStddev }) {
  const latest = await TrafficRanking.max('recorded_at');
  if (!latest) return;
  if (Date.now() - new Date(latest).getTime() > 15 * 60 * 1000) return;

  const rows = await TrafficRanking.findAll({ where: { recorded_at: latest }, raw: true });
  if (rows.length < 3) return;

  const values = rows.map(r => Number(r.bytes_down));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return;

  const threshold = mean + anomalyStddev * stddev;

  for (const row of rows) {
    const bytes_down = Number(row.bytes_down);
    if (bytes_down <= threshold) continue;
    const src_ip = row.ip_address;
    if (!src_ip) continue;
    if (isWhitelisted(src_ip, whitelist)) continue;
    if (await isDuplicate('traffic_anomaly', src_ip)) continue;

    const factor = ((bytes_down - mean) / stddev).toFixed(1);
    const severity = bytes_down > mean + 5 * stddev ? 'high' : bytes_down > mean + 4 * stddev ? 'medium' : 'low';
    const event = await SecurityEvent.create({
      event_type: 'traffic_anomaly', severity, src_ip,
      details: {
        bytes_down_mb: (bytes_down / 1024 / 1024).toFixed(2),
        mean_mb:       (mean / 1024 / 1024).toFixed(2),
        stddev_mb:     (stddev / 1024 / 1024).toFixed(2),
        stddev_factor: factor,
        hostname:      row.hostname    || null,
        mac_address:   row.mac_address || null
      }
    });
    logger.warn(`[Security] Anomalia de tráfego: ${src_ip} — ${factor}× desvio padrão`);
    sendSecurityAlert(event).catch(err => logger.error(`[Security] Webhook: ${err.message}`));
  }
}

// ─── Detector: Correlação ─────────────────────────────────────────────────────
// Roda após os outros detectores — se um IP disparou 2+ tipos de eventos na última hora,
// cria um evento 'high' de correlação.
async function detectCorrelation({ whitelist }) {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);

  const rows = await SecurityEvent.findAll({
    attributes: [
      'src_ip',
      [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('event_type'))), 'type_count']
    ],
    where: {
      detected_at: { [Op.gte]: since },
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'correlation'`)
      ]
    },
    group: ['src_ip'],
    having: sequelize.literal(`COUNT(DISTINCT event_type) > 1`),
    raw: true
  });

  for (const row of rows) {
    const src_ip = row.src_ip;
    if (!src_ip) continue;
    if (isWhitelisted(src_ip, whitelist)) continue;
    if (await isDuplicateSubtype(src_ip, 'correlation')) continue;

    const typeRows = await SecurityEvent.findAll({
      attributes: ['event_type'],
      where: {
        src_ip,
        detected_at: { [Op.gte]: since },
        [Op.and]: [
          sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
          sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
        ]
      },
      group: ['event_type'],
      raw: true
    });
    const types = typeRows.map(r => r.event_type);

    const event = await SecurityEvent.create({
      event_type: 'brute_force', severity: 'high', src_ip,
      details: { subtype: 'correlation', event_types: types, type_count: types.length }
    });
    logger.warn(`[Security] Correlação de ataques: ${src_ip} — ${types.join(', ')}`);
    sendSecurityAlert(event).catch(err => logger.error(`[Security] Webhook: ${err.message}`));
  }
}

// ─── Limpeza ──────────────────────────────────────────────────────────────────
async function cleanOldAttempts() {
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
  await SecurityEvent.destroy({
    where: {
      detected_at: { [Op.lt]: cutoff },
      [Op.and]: [sequelize.literal(`details->>'subtype' IN ('attempt', 'register_attempt')`)]
    }
  });
}

async function cleanOldEvents() {
  const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await SecurityEvent.destroy({
    where: {
      detected_at: { [Op.lt]: cutoff },
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
      ]
    }
  });
  if (deleted > 0) logger.info(`[Security] ${deleted} evento(s) antigo(s) removido(s).`);
}

// ─── Executor principal ───────────────────────────────────────────────────────
async function runAllDetectors() {
  logger.info('[Security] Executando detectores de ataque...');

  const settings = await loadSecuritySettings();

  // Detectores primários em paralelo
  await Promise.allSettled([
    detectBruteForce(settings).catch(err       => logger.error(`[Security] Força bruta: ${err.message}`)),
    detectRegisterFlood(settings).catch(err    => logger.error(`[Security] Flood registro: ${err.message}`)),
    detectPortScans(settings).catch(err        => logger.error(`[Security] Port scan: ${err.message}`)),
    detectDnsTunneling(settings).catch(err     => logger.error(`[Security] DNS tunneling: ${err.message}`)),
    detectTrafficAnomalies(settings).catch(err => logger.error(`[Security] Tráfego: ${err.message}`)),
    detectMacSpoofing(settings).catch(err      => logger.error(`[Security] MAC spoofing: ${err.message}`)),
    cleanOldAttempts().catch(err               => logger.error(`[Security] Limpeza tentativas: ${err.message}`)),
    cleanOldEvents().catch(err                 => logger.error(`[Security] Limpeza eventos: ${err.message}`))
  ]);

  // Correlação roda após os primários para capturar os eventos recém-criados
  await detectCorrelation(settings).catch(err => logger.error(`[Security] Correlação: ${err.message}`));

  logger.info('[Security] Detectores concluídos.');
}

module.exports = { runAllDetectors, detectBruteForce, detectPortScans, detectTrafficAnomalies };
