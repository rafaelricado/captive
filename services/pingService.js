const { execFile } = require('child_process');
const os = require('os');
const axios = require('axios');
const logger = require('../utils/logger');

const IS_WINDOWS = os.platform() === 'win32';

// Valida IPv4 para evitar injeção de comandos (execFile já protege, mas validamos por segurança)
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function isValidIPv4(ip) {
  const m = IPV4_RE.exec(ip);
  return m ? m.slice(1).every(n => parseInt(n, 10) <= 255) : false;
}

/**
 * Realiza um ping ICMP no host e retorna { online, latency_ms }.
 * Usa execFile (sem shell) — imune a injeção de comandos.
 */
function pingHost(ip, timeoutSecs = 2) {
  return new Promise((resolve) => {
    if (!isValidIPv4(ip)) {
      return resolve({ online: false, latency_ms: null });
    }

    const args = IS_WINDOWS
      ? ['-n', '1', '-w', String(timeoutSecs * 1000), ip]
      : ['-c', '1', '-W', String(timeoutSecs), ip];

    const start = Date.now();

    execFile('ping', args, { timeout: (timeoutSecs + 2) * 1000 }, (err, stdout) => {
      const elapsed = Date.now() - start;

      if (err) return resolve({ online: false, latency_ms: null });

      const online = IS_WINDOWS
        ? /TTL=/i.test(stdout)
        : /1 received/i.test(stdout);

      // Tenta extrair latência real do output do ping
      let latency_ms = online ? elapsed : null;
      if (online) {
        const match = IS_WINDOWS
          ? stdout.match(/[=<](\d+)ms/i)
          : stdout.match(/time[=<]([\d.]+)\s*ms/i);
        if (match) latency_ms = Math.round(parseFloat(match[1]));
      }

      resolve({ online, latency_ms });
    });
  });
}

const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE || 'America/Sao_Paulo';

// Delays entre tentativas: 0s, 2s, 5s
const WEBHOOK_RETRY_DELAYS = [0, 2000, 5000];

/**
 * Envia alerta via webhook quando um AP fica offline.
 * Tenta até 3 vezes com backoff antes de desistir.
 * Compatível com Slack, Discord, Microsoft Teams e qualquer receptor HTTP.
 */
async function sendOfflineAlert(webhookUrl, ap) {
  if (!webhookUrl) return;
  const now = new Date().toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE });
  const location = ap.location ? ` — ${ap.location}` : '';
  // Suporte a múltiplos formatos: Slack/Teams usam "text", Discord usa "content"
  const payload = {
    text: `⚠️ AP OFFLINE: ${ap.name} (${ap.ip_address})${location} | ${now}`,
    content: `⚠️ AP OFFLINE: ${ap.name} (${ap.ip_address})${location} | ${now}`
  };

  for (let attempt = 0; attempt < WEBHOOK_RETRY_DELAYS.length; attempt++) {
    if (WEBHOOK_RETRY_DELAYS[attempt] > 0) {
      await new Promise(r => setTimeout(r, WEBHOOK_RETRY_DELAYS[attempt]));
    }
    try {
      await axios.post(webhookUrl, payload, { timeout: 5000 });
      logger.info(`[Ping] Alerta de webhook enviado: ${ap.name} offline (tentativa ${attempt + 1})`);
      return;
    } catch (err) {
      logger.warn(`[Ping] Falha tentativa ${attempt + 1}/${WEBHOOK_RETRY_DELAYS.length} para ${ap.name}: ${err.message}`);
    }
  }
  logger.error(`[Ping] Todas as tentativas de webhook falharam para ${ap.name}`);
}

/**
 * Pinga todos os pontos de acesso ativos, atualiza o banco,
 * salva histórico de latência e dispara webhook quando AP fica offline.
 */
async function pingAllAccessPoints() {
  const { AccessPoint, ApPingHistory, Setting } = require('../models');

  const aps = await AccessPoint.findAll({ where: { active: true } });
  if (aps.length === 0) return [];

  const webhookUrl = await Setting.get('alert_webhook_url', '');
  const now = new Date();

  const results = await Promise.all(
    aps.map(async (ap) => {
      const previousOnline = ap.is_online; // estado ANTES do ping atual
      const { online, latency_ms } = await pingHost(ap.ip_address);

      // Atualiza estado atual no AP
      await ap.update({ is_online: online, latency_ms, last_checked_at: now });

      // Salva no histórico de pings — erro aqui não deve derrubar o ciclo completo
      try {
        await ApPingHistory.create({ ap_id: ap.id, is_online: online, latency_ms, checked_at: now });

        // Limpa registros antigos: mantém apenas os últimos MAX_PER_AP por AP
        const total = await ApPingHistory.count({ where: { ap_id: ap.id } });
        if (total > ApPingHistory.MAX_PER_AP) {
          const oldest = await ApPingHistory.findAll({
            where: { ap_id: ap.id },
            order: [['checked_at', 'ASC']],
            limit: total - ApPingHistory.MAX_PER_AP,
            attributes: ['id']
          });
          if (oldest.length > 0) {
            await ApPingHistory.destroy({ where: { id: oldest.map(r => r.id) } });
          }
        }
      } catch (histErr) {
        logger.warn(`[Ping] Erro ao salvar histórico do AP ${ap.name}: ${histErr.message}`);
      }

      // Dispara alerta se AP que estava online agora está offline
      if (previousOnline === true && !online) {
        logger.warn(`[Ping] AP OFFLINE detectado: ${ap.name} (${ap.ip_address})`);
        await sendOfflineAlert(webhookUrl, ap);
      } else if (previousOnline === false && online) {
        logger.info(`[Ping] AP voltou online: ${ap.name} (${ap.ip_address})`);
      }

      return { id: ap.id, name: ap.name, ip_address: ap.ip_address, online, latency_ms };
    })
  );

  const onlineCount = results.filter(r => r.online).length;
  logger.info(`[Ping] ${results.length} AP(s) verificado(s): ${onlineCount} online, ${results.length - onlineCount} offline`);

  return results;
}

module.exports = { pingHost, pingAllAccessPoints, isValidIPv4 };
