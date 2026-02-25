const crypto = require('crypto');
const { Op } = require('sequelize');
const { TrafficRanking, WanStat, ClientConnection, DnsEntry, Setting, sequelize } = require('../models');
const logger = require('../utils/logger');

// Formata bytes em string legível (usado nos logs)
function fmtBytes(b) {
  const n = Number(b);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + ' KB';
  return n + ' B';
}

// Parseia inteiro grande de string sem perda de precisão acima de 2⁵³
// Retorna string numérica: Sequelize envia BIGINT como string ao PostgreSQL
function safeInt(s) {
  const trimmed = (s || '').trim();
  return /^\d+$/.test(trimmed) ? trimmed : '0';
}

// Valida a API key enviada pelo Mikrotik usando comparação em tempo constante
async function isKeyValid(key) {
  if (!key) return false;
  const setting = await Setting.findOne({ where: { key: 'mikrotik_data_key' } });
  const configured = setting ? setting.value : (process.env.MIKROTIK_DATA_KEY || '');
  if (!configured) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(configured));
  } catch {
    return false; // buffers de tamanhos diferentes
  }
}

// Parse do CSV de clientes: "IP,Hostname[MAC],bytes_up,bytes_down;"
function parseClientsCsv(raw) {
  if (!raw) return [];
  const result = [];
  const entries = raw.split(';').map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split(',');
    if (parts.length < 4) continue;

    const ip = parts[0].trim();
    const hostAndMac = parts[1].trim(); // ex: "NOTEBOOK01 [AA:BB:CC:DD:EE:FF]"
    const bytesUp   = safeInt(parts[2]);
    const bytesDown = safeInt(parts[3]);

    // Extrai hostname e MAC: "Hostname [MAC]"
    const macMatch = hostAndMac.match(/\[([^\]]+)\]$/);
    const mac = macMatch ? macMatch[1].trim() : null;
    const hostname = macMatch
      ? hostAndMac.slice(0, macMatch.index).trim()
      : hostAndMac;

    if (!ip) continue;
    result.push({ ip_address: ip, hostname: hostname || null, mac_address: mac, bytes_up: bytesUp, bytes_down: bytesDown });
  }
  return result;
}

// Parse do CSV de interfaces WAN: "NomeInterface,tx_delta,rx_delta,up|down;"
function parseIfaceCsv(raw) {
  if (!raw) return [];
  const result = [];
  const entries = raw.split(';').map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split(',');
    if (parts.length < 4) continue;
    result.push({
      interface_name: parts[0].trim(),
      tx_bytes: safeInt(parts[1]),
      rx_bytes: safeInt(parts[2]),
      is_up: parts[3].trim().toLowerCase() === 'up'
    });
  }
  return result;
}

// Parse do CSV de conexões: "srcIP,dstIP,dport,bytes_orig,bytes_reply;"
function parseConnectionsCsv(raw) {
  if (!raw) return [];
  const result = [];
  const entries = raw.split(';').map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split(',');
    if (parts.length < 5) continue;
    const port = parseInt(parts[2], 10);
    result.push({
      src_ip:      parts[0].trim(),
      dst_ip:      parts[1].trim(),
      dst_port:    isNaN(port) ? null : port,
      bytes_orig:  safeInt(parts[3]),
      bytes_reply: safeInt(parts[4])
    });
  }
  return result;
}

// Parse do CSV de DNS: "dominio>ip;"
function parseDnsCsv(raw) {
  if (!raw) return [];
  const result = [];
  const entries = raw.split(';').map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const idx = entry.indexOf('>');
    if (idx < 0) continue;
    const domain = entry.slice(0, idx).trim();
    const ip = entry.slice(idx + 1).trim();
    if (!domain) continue;
    result.push({ domain, ip_address: ip || null });
  }
  return result;
}

// POST /api/mikrotik/traffic
// Recebe: key, router, data (CSV clientes), iface (CSV interfaces WAN)
exports.receiveTraffic = async (req, res) => {
  try {
    const { key, router, data, iface } = req.body;

    if (!(await isKeyValid(key))) {
      logger.warn('[MikrotikData] Tentativa com chave inválida');
      return res.status(401).json({ error: 'Chave inválida.' });
    }

    const now = new Date();
    const routerName = (router || '').substring(0, 100);

    // Parseia e insere ranking de clientes
    const clients = parseClientsCsv(data);
    if (clients.length > 0) {
      const rows = clients.map(c => ({ ...c, router_name: routerName, recorded_at: now }));
      await TrafficRanking.bulkCreate(rows);
    }

    // Parseia e insere estatísticas WAN
    const ifaces = parseIfaceCsv(iface);
    if (ifaces.length > 0) {
      const rows = ifaces.map(i => ({ ...i, router_name: routerName, recorded_at: now }));
      await WanStat.bulkCreate(rows);
    }

    // Limpeza de dados antigos (assíncrona, não bloqueia a resposta)
    TrafficRanking.destroy({
      where: { recorded_at: { [Op.lt]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }
    }).catch(err => logger.warn(`[MikrotikData] Erro ao limpar traffic_rankings: ${err.message}`));

    WanStat.destroy({
      where: { recorded_at: { [Op.lt]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }
    }).catch(err => logger.warn(`[MikrotikData] Erro ao limpar wan_stats: ${err.message}`));

    logger.info(`[MikrotikData] Traffic: ${clients.length} clientes, ${ifaces.length} interfaces (router: ${routerName})`);
    res.json({ ok: true });
  } catch (err) {
    logger.error(`[MikrotikData] Erro em receiveTraffic: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

// POST /api/mikrotik/details
// Recebe: key, router, connections (CSV), dns (CSV)
exports.receiveDetails = async (req, res) => {
  try {
    const { key, router, connections, dns } = req.body;

    if (!(await isKeyValid(key))) {
      logger.warn('[MikrotikData] Tentativa com chave inválida');
      return res.status(401).json({ error: 'Chave inválida.' });
    }

    const now = new Date();
    const routerName = (router || '').substring(0, 100);

    const connRows = parseConnectionsCsv(connections);
    const dnsRows  = parseDnsCsv(dns);

    // Operações atômicas: substitui snapshots dentro de uma transação
    // Se bulkCreate falhar, o destroy é revertido e os dados anteriores são preservados
    await sequelize.transaction(async (t) => {
      await ClientConnection.destroy({ where: {}, transaction: t });
      if (connRows.length > 0) {
        await ClientConnection.bulkCreate(
          connRows.map(c => ({ ...c, router_name: routerName, recorded_at: now })),
          { transaction: t }
        );
      }

      await DnsEntry.destroy({ where: {}, transaction: t });
      if (dnsRows.length > 0) {
        await DnsEntry.bulkCreate(
          dnsRows.map(d => ({ ...d, router_name: routerName, recorded_at: now })),
          { transaction: t }
        );
      }
    });

    logger.info(`[MikrotikData] Details: ${connRows.length} conexões, ${dnsRows.length} entradas DNS (router: ${routerName})`);
    res.json({ ok: true });
  } catch (err) {
    logger.error(`[MikrotikData] Erro em receiveDetails: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};
