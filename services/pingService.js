const { execFile } = require('child_process');
const os = require('os');

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

    const cmd = IS_WINDOWS ? 'ping' : 'ping';
    const start = Date.now();

    execFile(cmd, args, { timeout: (timeoutSecs + 2) * 1000 }, (err, stdout) => {
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

/**
 * Pinga todos os pontos de acesso ativos e atualiza o banco.
 * Retorna array com resultados: [{ id, name, ip_address, online, latency_ms }]
 */
async function pingAllAccessPoints() {
  const { AccessPoint } = require('../models');
  const aps = await AccessPoint.findAll({ where: { active: true } });

  if (aps.length === 0) return [];

  const results = await Promise.all(
    aps.map(async (ap) => {
      const { online, latency_ms } = await pingHost(ap.ip_address);
      await ap.update({
        is_online: online,
        latency_ms,
        last_checked_at: new Date()
      });
      return { id: ap.id, name: ap.name, ip_address: ap.ip_address, online, latency_ms };
    })
  );

  const online = results.filter(r => r.online).length;
  console.log(`[Ping] ${results.length} AP(s) verificado(s): ${online} online, ${results.length - online} offline`);

  return results;
}

module.exports = { pingHost, pingAllAccessPoints, isValidIPv4 };
