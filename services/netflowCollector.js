'use strict';

const Collector       = require('node-netflowv9');
const { RouterOSAPI } = require('node-routeros');
const { Op }          = require('sequelize');
const logger          = require('../utils/logger');
const { TrafficRanking, WanStat } = require('../models');

// ─── Configuração ─────────────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS  = 5  * 60 * 1000;   // flush ao banco a cada 5 min
const LEASE_REFRESH_MS   = 10 * 60 * 1000;   // atualiza cache de leases a cada 10 min
const RETENTION_DAYS     = 30;               // remove registros com mais de N dias
const LOCAL_SUBNET       = process.env.LOCAL_SUBNET || '10.0.0.0/22';
const NETFLOW_PORT       = parseInt(process.env.NETFLOW_PORT || '2055', 10);

// ─── Estado interno ───────────────────────────────────────────────────────────
// acumulador de tráfego: ip -> { up: Number, down: Number }
const accumulator = new Map();
let flushing = false;  // guard contra flush concorrente

// cache DHCP: ip -> { hostname, mac }
let leaseCache        = new Map();
let lastLeaseRefresh  = 0;
let routerIdentity    = null;

// contadores acumulados de interface WAN (para calcular delta)
// ifaceName → { tx: BigInt, rx: BigInt }
const prevWanCounters = new Map();

// ─── Utilitários de subnet ────────────────────────────────────────────────────
function ipToUint32(ip) {
  return ip.split('.').reduce((acc, o) => (acc * 256 + parseInt(o, 10)) >>> 0, 0);
}

function buildSubnetMatcher(cidr) {
  const [netIp, prefix] = cidr.split('/');
  const bits   = parseInt(prefix, 10);
  const mask   = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
  const netNum = ipToUint32(netIp) & mask;
  return (ip) => (ipToUint32(ip) & mask) === netNum;
}

// Resolvida uma vez no carregamento do módulo — não recalcula por flow
const isLocal = buildSubnetMatcher(LOCAL_SUBNET);

// ─── Processamento de flow ────────────────────────────────────────────────────
function processFlow(f) {
  const src   = f.ipv4_src_addr;
  const dst   = f.ipv4_dst_addr;
  const bytes = Number(f.in_bytes || 0);

  if (!src || !dst || bytes === 0) return;

  const srcLocal = isLocal(src);
  const dstLocal = isLocal(dst);

  if (srcLocal && !dstLocal) {
    // Upload: cliente → internet
    const e = accumulator.get(src) || { up: 0, down: 0 };
    e.up += bytes;
    accumulator.set(src, e);
  } else if (!srcLocal && dstLocal) {
    // Download: internet → cliente
    const e = accumulator.get(dst) || { up: 0, down: 0 };
    e.down += bytes;
    accumulator.set(dst, e);
  }
  // local→local ou externo→externo: ignorado
}

// ─── Detecção de interface WAN a partir de rota ───────────────────────────────
// gateway pode ser:  "192.168.1.1"      → IP (retorna null)
//                    "192.168.1.1%ether5" → IP%iface (retorna "ether5")
//                    "pppoe-out1"        → nome de interface (retorna "pppoe-out1")
function extractRouteInterface(r) {
  if (r['gateway-interface']) return r['gateway-interface'];
  const gw = r.gateway || '';
  if (!gw) return null;
  if (gw.includes('%')) return gw.split('%')[1];            // formato "IP%iface"
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(gw)) return gw;        // nome de interface
  return null;
}

// ─── Coleta de estatísticas WAN ───────────────────────────────────────────────
async function collectWanStats(api, now) {
  // Busca todas as rotas padrão (0.0.0.0/0) → identifica interfaces WAN
  const routes = await api.write('/ip/route/print', [
    '?dst-address=0.0.0.0/0'
  ]);

  const wanIfaceNames  = new Set();
  const activeIfaceSet = new Set();

  for (const r of routes) {
    const ifaceName = extractRouteInterface(r);
    if (ifaceName) {
      wanIfaceNames.add(ifaceName);
      if (r.active === 'true') activeIfaceSet.add(ifaceName);
    }
  }

  // Para rotas com gateway=IP, tenta resolver a interface via ARP
  const ipGwRoutes = routes.filter(r => {
    const gw = r.gateway || '';
    return /^\d+\.\d+\.\d+\.\d+$/.test(gw) && !gw.includes('%');
  });
  if (ipGwRoutes.length > 0) {
    try {
      const arpEntries = await api.write('/ip/arp/print', ['=.proplist=address,interface']);
      const arpMap = new Map(arpEntries.map(a => [a.address, a.interface]));
      for (const r of ipGwRoutes) {
        const gwIface = arpMap.get(r.gateway);
        if (gwIface) {
          wanIfaceNames.add(gwIface);
          if (r.active === 'true') activeIfaceSet.add(gwIface);
        }
      }
    } catch (_) {
      // ARP lookup é opcional — ignora se falhar
    }
  }

  // WAN_INTERFACES env var: permite adicionar interfaces manualmente
  // ex: WAN_INTERFACES=ether5,pppoe-out1
  const envWan = (process.env.WAN_INTERFACES || '').split(',').map(s => s.trim()).filter(Boolean);
  envWan.forEach(n => wanIfaceNames.add(n));

  if (wanIfaceNames.size === 0) {
    logger.warn('[Netflow] WAN stats: nenhuma interface WAN detectada. Defina WAN_INTERFACES no .env se necessário');
    return;
  }

  // Busca stats de todas as interfaces
  const ifaces = await api.write('/interface/print', [
    '=.proplist=name,tx-byte,rx-byte,running,disabled'
  ]);
  const ifaceMap = new Map(ifaces.map(i => [i.name, i]));

  const records = [];
  for (const name of wanIfaceNames) {
    const iface = ifaceMap.get(name);
    if (!iface) continue;

    const txCurr = BigInt(iface['tx-byte'] || '0');
    const rxCurr = BigInt(iface['rx-byte'] || '0');
    const prev   = prevWanCounters.get(name);

    // Salva leitura atual para cálculo do delta no próximo ciclo
    prevWanCounters.set(name, { tx: txCurr, rx: rxCurr });

    if (!prev) continue;  // primeira leitura — sem delta ainda

    // Delta: bytes transferidos desde a última leitura (trata reset de contador)
    const txDelta = txCurr >= prev.tx ? txCurr - prev.tx : txCurr;
    const rxDelta = rxCurr >= prev.rx ? rxCurr - prev.rx : rxCurr;

    records.push({
      interface_name:  name,
      tx_bytes:        txDelta.toString(),
      rx_bytes:        rxDelta.toString(),
      is_up:           iface.running === 'true',
      is_active_route: activeIfaceSet.has(name),
      router_name:     routerIdentity || 'mikrotik',
      recorded_at:     now
    });
  }

  if (records.length > 0) {
    await WanStat.bulkCreate(records);
    logger.info(`[Netflow] WAN stats: ${records.length} interface(s) gravadas`);
  } else {
    logger.info('[Netflow] WAN stats: primeira leitura — próximo flush terá dados de delta');
  }
}

// ─── Atualização de dados do Mikrotik (leases DHCP + WAN stats) ───────────────
// Chamado em cada flush. Leases atualizam a cada 10 min; WAN stats, a cada flush.
async function refreshMikrotikData() {
  const host     = process.env.MIKROTIK_HOST;
  const user     = process.env.MIKROTIK_USER;
  const password = process.env.MIKROTIK_PASS;
  const port     = parseInt(process.env.MIKROTIK_PORT || '8728', 10);

  if (!host || !user || !password) {
    logger.warn('[Netflow] MIKROTIK_HOST/USER/PASS não configurados — hostname e WAN stats não disponíveis');
    return;
  }

  const now        = Date.now();
  const needLeases = now - lastLeaseRefresh >= LEASE_REFRESH_MS;

  let api;
  try {
    api = new RouterOSAPI({ host, user, password, port, timeout: 10 });
    await api.connect();

    if (!routerIdentity) {
      const id = await api.write('/system/identity/print');
      routerIdentity = id[0]?.name || null;
    }

    // ── DHCP leases (a cada 10 min) ──────────────────────────────────────────
    if (needLeases) {
      try {
        const leases = await api.write('/ip/dhcp-server/lease/print', [
          '=.proplist=address,host-name,mac-address',
          '?status=bound'
        ]);
        const newCache = new Map();
        for (const l of leases) {
          if (l.address) {
            newCache.set(l.address, {
              hostname: l['host-name']    || null,
              mac:      l['mac-address'] || null
            });
          }
        }
        leaseCache = newCache;
        lastLeaseRefresh = now;
        logger.info(`[Netflow] Cache DHCP atualizado: ${newCache.size} leases`);
      } catch (err) {
        logger.warn(`[Netflow] Falha ao buscar leases DHCP: ${err.message}`);
        lastLeaseRefresh = 0;  // permite nova tentativa no próximo flush
      }
    }

    // ── WAN stats (todo flush = 5 min) ────────────────────────────────────────
    try {
      await collectWanStats(api, new Date());
    } catch (err) {
      logger.warn(`[Netflow] Falha ao coletar WAN stats: ${err.message}`);
    }

  } catch (err) {
    logger.warn(`[Netflow] Falha na conexão Mikrotik: ${err.message}`);
    if (needLeases) lastLeaseRefresh = 0;
  } finally {
    if (api) { try { api.disconnect(); } catch (_) {} }
  }
}

// ─── Flush ao banco ───────────────────────────────────────────────────────────
async function flush() {
  // Atualiza dados do Mikrotik (WAN stats + leases se necessário)
  await refreshMikrotikData();

  if (accumulator.size === 0) {
    logger.info('[Netflow] Flush: nenhum dado de tráfego acumulado');
    return;
  }

  const now     = new Date();
  const records = [];

  for (const [ip, { up, down }] of accumulator) {
    if (up === 0 && down === 0) continue;
    const lease = leaseCache.get(ip) || {};
    records.push({
      ip_address:  ip,
      hostname:    lease.hostname || null,
      mac_address: lease.mac     || null,
      bytes_up:    up,
      bytes_down:  down,
      router_name: routerIdentity || 'mikrotik',
      recorded_at: now
    });
  }

  if (records.length === 0) {
    logger.info('[Netflow] Flush: todos os acumuladores zerados');
    accumulator.clear();
    return;
  }

  try {
    await TrafficRanking.bulkCreate(records);
    logger.info(`[Netflow] Flush: ${records.length} registros gravados (${now.toISOString()})`);
    accumulator.clear();

    // Limpeza assíncrona de registros antigos (não bloqueia o flush)
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    TrafficRanking.destroy({ where: { recorded_at: { [Op.lt]: cutoff } } })
      .catch(err => logger.warn(`[Netflow] Erro ao limpar dados antigos: ${err.message}`));

  } catch (err) {
    logger.error(`[Netflow] Erro ao gravar no banco: ${err.message}`);
    // Mantém acumulador para tentar de novo no próximo ciclo
  }
}

// ─── Inicialização do coletor UDP ─────────────────────────────────────────────
function startNetflowCollector() {
  const collector = Collector(function onPacket(data) {
    try {
      const flows = data.flows || data.flow;
      if (!Array.isArray(flows)) return;
      flows.forEach(processFlow);
    } catch (err) {
      logger.warn(`[Netflow] Erro ao processar pacote: ${err.message}`);
    }
  });

  collector.on('error', (err) => {
    logger.error(`[Netflow] Erro no socket UDP: ${err.message}`);
  });

  collector.listen(NETFLOW_PORT);
  logger.info(`[Netflow] Coletor escutando UDP :${NETFLOW_PORT} | subnet local: ${LOCAL_SUBNET}`);

  // Flush periódico — guard impede execuções sobrepostas
  setInterval(() => {
    if (flushing) {
      logger.warn('[Netflow] Flush anterior ainda em andamento, pulando ciclo');
      return;
    }
    flushing = true;
    flush()
      .catch(err => logger.error(`[Netflow] Erro no flush periódico: ${err.message}`))
      .finally(() => { flushing = false; });
  }, FLUSH_INTERVAL_MS);

  // Leitura inicial do Mikrotik: coleta identity, leases e primeira leitura de WAN
  // (após 5s para aguardar o banco conectar)
  setTimeout(() => {
    refreshMikrotikData().catch(() => {});
  }, 5000);
}

module.exports = { startNetflowCollector };
