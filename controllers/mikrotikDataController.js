const { Op } = require('sequelize');
const { TrafficRanking, WanStat, ClientConnection, DnsEntry, Setting } = require('../models');
const logger = require('../utils/logger');

// Formata bytes em string legível (usado nos logs)
function fmtBytes(b) {
  const n = Number(b);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + ' KB';
  return n + ' B';
}

// Valida a API key enviada pelo Mikrotik
async function isKeyValid(key) {
  if (!key) return false;
  const setting = await Setting.findOne({ where: { key: 'mikrotik_data_key' } });
  const configured = setting ? setting.value : (process.env.MIKROTIK_DATA_KEY || '');
  if (!configured) return false;
  return key === configured;
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
    const bytesUp = parseInt(parts[2], 10) || 0;
    const bytesDown = parseInt(parts[3], 10) || 0;

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
      tx_bytes: parseInt(parts[1], 10) || 0,
      rx_bytes: parseInt(parts[2], 10) || 0,
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
    result.push({
      src_ip: parts[0].trim(),
      dst_ip: parts[1].trim(),
      dst_port: parseInt(parts[2], 10) || null,
      bytes_orig: parseInt(parts[3], 10) || 0,
      bytes_reply: parseInt(parts[4], 10) || 0
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

    // Substitui snapshot de conexões
    const connRows = parseConnectionsCsv(connections);
    await ClientConnection.destroy({ where: {} });
    if (connRows.length > 0) {
      await ClientConnection.bulkCreate(
        connRows.map(c => ({ ...c, router_name: routerName, recorded_at: now }))
      );
    }

    // Substitui snapshot de DNS
    const dnsRows = parseDnsCsv(dns);
    await DnsEntry.destroy({ where: {} });
    if (dnsRows.length > 0) {
      await DnsEntry.bulkCreate(
        dnsRows.map(d => ({ ...d, router_name: routerName, recorded_at: now }))
      );
    }

    logger.info(`[MikrotikData] Details: ${connRows.length} conexões, ${dnsRows.length} entradas DNS (router: ${routerName})`);
    res.json({ ok: true });
  } catch (err) {
    logger.error(`[MikrotikData] Erro em receiveDetails: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};
