const axios = require('axios');
const { Op } = require('sequelize');
const { SecurityEvent, ClientConnection, TrafficRanking, Setting, sequelize } = require('../models');
const logger = require('../utils/logger');

const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE || 'America/Sao_Paulo';

// ─── Constantes ────────────────────────────────────────────────────────────────
const BRUTE_FORCE_WINDOW_MS = 15 * 60 * 1000; // 15 minutos
const BRUTE_FORCE_THRESHOLD = 5;               // tentativas
const PORT_SCAN_WINDOW_MS   = 10 * 60 * 1000; // 10 minutos
const PORT_SCAN_THRESHOLD   = 20;              // portas distintas
const ANOMALY_STDDEV_FACTOR = 3;               // mean + N*stddev
const DEDUP_WINDOW_MS       = 60 * 60 * 1000; // 1 hora (sem duplicatas)
const EVENT_RETENTION_DAYS  = 30;             // dias para manter eventos confirmados

const WEBHOOK_RETRY_DELAYS  = [0, 2000, 5000];

// ─── Webhook ───────────────────────────────────────────────────────────────────

const EVENT_TYPE_LABELS = {
  brute_force:     'Força Bruta',
  port_scan:       'Varredura de Portas',
  traffic_anomaly: 'Anomalia de Tráfego'
};

const SEVERITY_LABELS = { low: 'Baixa', medium: 'Média', high: 'Alta' };

async function sendSecurityAlert(event) {
  const webhookUrl = await Setting.get('alert_webhook_url', '');
  if (!webhookUrl) return;

  const typeLabel     = EVENT_TYPE_LABELS[event.event_type] || event.event_type;
  const severityLabel = SEVERITY_LABELS[event.severity] || event.severity;
  const now = new Date().toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE });
  const msg = `🚨 Ataque detectado: ${typeLabel} | IP: ${event.src_ip} | Severidade: ${severityLabel} | ${now}`;

  const payload = { text: msg, content: msg };

  for (let attempt = 0; attempt < WEBHOOK_RETRY_DELAYS.length; attempt++) {
    if (WEBHOOK_RETRY_DELAYS[attempt] > 0) {
      await new Promise(r => setTimeout(r, WEBHOOK_RETRY_DELAYS[attempt]));
    }
    try {
      await axios.post(webhookUrl, payload, { timeout: 5000 });
      logger.info(`[Security] Alerta de webhook enviado: ${event.event_type} / ${event.src_ip}`);
      return;
    } catch (err) {
      logger.warn(`[Security] Falha tentativa ${attempt + 1}/${WEBHOOK_RETRY_DELAYS.length} webhook: ${err.message}`);
    }
  }
  logger.error(`[Security] Todas as tentativas de webhook falharam para ${event.event_type} / ${event.src_ip}`);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Retorna true se já existe um evento confirmado (não-attempt) do mesmo tipo+IP
 * criado nos últimos 60 min — evita spam de eventos duplicados.
 */
async function isDuplicate(event_type, src_ip) {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const existing = await SecurityEvent.findOne({
    where: {
      event_type,
      src_ip,
      detected_at: { [Op.gte]: since },
      [Op.and]: [sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`)]
    }
  });
  return !!existing;
}

// ─── Detector: Força Bruta ─────────────────────────────────────────────────────

async function detectBruteForce() {
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
    having: sequelize.literal(`COUNT(id) >= ${BRUTE_FORCE_THRESHOLD}`),
    raw: true
  });

  for (const row of rows) {
    const src_ip = row.src_ip;
    const attempt_count = Number(row.attempt_count);

    if (await isDuplicate('brute_force', src_ip)) continue;

    const severity = attempt_count >= 20 ? 'high' : attempt_count >= 10 ? 'medium' : 'low';

    const event = await SecurityEvent.create({
      event_type: 'brute_force',
      severity,
      src_ip,
      details: {
        attempt_count,
        window_minutes: BRUTE_FORCE_WINDOW_MS / 60000,
        threshold: BRUTE_FORCE_THRESHOLD
      }
    });

    logger.warn(`[Security] Força bruta detectada: ${src_ip} — ${attempt_count} tentativas em ${BRUTE_FORCE_WINDOW_MS / 60000} min`);
    sendSecurityAlert(event).catch(err => logger.error(`[Security] Webhook: ${err.message}`));
  }
}

// ─── Detector: Varredura de Portas ─────────────────────────────────────────────

async function detectPortScans() {
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
    having: sequelize.literal(`COUNT(DISTINCT dst_port) >= ${PORT_SCAN_THRESHOLD}`),
    raw: true
  });

  for (const row of rows) {
    const src_ip = row.src_ip;
    if (!src_ip) continue; // ignora linhas com src_ip nulo

    const distinct_ports = Number(row.distinct_ports);

    if (await isDuplicate('port_scan', src_ip)) continue;

    const severity = distinct_ports >= 100 ? 'high' : distinct_ports >= 50 ? 'medium' : 'low';

    const event = await SecurityEvent.create({
      event_type: 'port_scan',
      severity,
      src_ip,
      details: {
        distinct_ports,
        window_minutes: PORT_SCAN_WINDOW_MS / 60000,
        threshold: PORT_SCAN_THRESHOLD
      }
    });

    logger.warn(`[Security] Varredura de portas detectada: ${src_ip} — ${distinct_ports} portas distintas em ${PORT_SCAN_WINDOW_MS / 60000} min`);
    sendSecurityAlert(event).catch(err => logger.error(`[Security] Webhook: ${err.message}`));
  }
}

// ─── Detector: Anomalia de Tráfego ─────────────────────────────────────────────

async function detectTrafficAnomalies() {
  const latest = await TrafficRanking.max('recorded_at');
  if (!latest) return;

  // Ignora snapshots mais velhos que 15 minutos (Mikrotik offline ou flush atrasado)
  if (Date.now() - new Date(latest).getTime() > 15 * 60 * 1000) return;

  const rows = await TrafficRanking.findAll({
    where: { recorded_at: latest },
    raw: true
  });

  if (rows.length < 3) return; // dados insuficientes para estatística

  const values = rows.map(r => Number(r.bytes_down));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  // Variância amostral (divide por n-1) — mais precisa para amostras pequenas
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
  const stddev = Math.sqrt(variance);

  if (stddev === 0) return; // todos idênticos

  const threshold = mean + ANOMALY_STDDEV_FACTOR * stddev;

  for (const row of rows) {
    const bytes_down = Number(row.bytes_down);
    if (bytes_down <= threshold) continue;

    const src_ip = row.ip_address;
    if (await isDuplicate('traffic_anomaly', src_ip)) continue;

    const factor = ((bytes_down - mean) / stddev).toFixed(1);
    const severity = bytes_down > mean + 5 * stddev ? 'high' : bytes_down > mean + 4 * stddev ? 'medium' : 'low';

    const event = await SecurityEvent.create({
      event_type: 'traffic_anomaly',
      severity,
      src_ip,
      details: {
        bytes_down_mb: (bytes_down / 1024 / 1024).toFixed(2),
        mean_mb: (mean / 1024 / 1024).toFixed(2),
        stddev_mb: (stddev / 1024 / 1024).toFixed(2),
        stddev_factor: factor,
        hostname: row.hostname || null,
        mac_address: row.mac_address || null
      }
    });

    logger.warn(`[Security] Anomalia de tráfego detectada: ${src_ip} — ${(bytes_down / 1024 / 1024).toFixed(2)} MB (${factor}× desvio padrão)`);
    sendSecurityAlert(event).catch(err => logger.error(`[Security] Webhook: ${err.message}`));
  }
}

// ─── Limpeza ───────────────────────────────────────────────────────────────────

async function cleanOldAttempts() {
  // Remove tentativas de força bruta com mais de 1 hora
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
  await SecurityEvent.destroy({
    where: {
      detected_at: { [Op.lt]: cutoff },
      [Op.and]: [sequelize.literal(`details->>'subtype' = 'attempt'`)]
    }
  });
}

async function cleanOldEvents() {
  // Remove eventos confirmados com mais de 30 dias
  const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await SecurityEvent.destroy({
    where: {
      detected_at: { [Op.lt]: cutoff },
      [Op.and]: [sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`)]
    }
  });
  if (deleted > 0) logger.info(`[Security] ${deleted} evento(s) antigo(s) removido(s).`);
}

// ─── Executor principal ─────────────────────────────────────────────────────────

async function runAllDetectors() {
  logger.info('[Security] Executando detectores de ataque...');
  await Promise.allSettled([
    detectBruteForce().catch(err => logger.error(`[Security] Erro no detector de força bruta: ${err.message}`)),
    detectPortScans().catch(err => logger.error(`[Security] Erro no detector de port scan: ${err.message}`)),
    detectTrafficAnomalies().catch(err => logger.error(`[Security] Erro no detector de tráfego: ${err.message}`)),
    cleanOldAttempts().catch(err => logger.error(`[Security] Erro ao limpar tentativas antigas: ${err.message}`)),
    cleanOldEvents().catch(err => logger.error(`[Security] Erro ao limpar eventos antigos: ${err.message}`))
  ]);
  logger.info('[Security] Detectores concluídos.');
}

module.exports = { runAllDetectors, detectBruteForce, detectPortScans, detectTrafficAnomalies };
