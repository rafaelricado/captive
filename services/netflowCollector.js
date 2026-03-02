'use strict';

const Collector   = require('node-netflowv9');
const { RouterOSAPI } = require('node-routeros');
const { Op }      = require('sequelize');
const logger      = require('../utils/logger');
const { TrafficRanking } = require('../models');

// ─── Configuração ─────────────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS  = 5  * 60 * 1000;   // flush ao banco a cada 5 min
const LEASE_REFRESH_MS   = 10 * 60 * 1000;   // atualiza cache de leases a cada 10 min
const RETENTION_DAYS     = 30;               // remove registros com mais de N dias
const LOCAL_SUBNET       = process.env.LOCAL_SUBNET || '10.0.0.0/22';
const NETFLOW_PORT       = parseInt(process.env.NETFLOW_PORT || '2055', 10);

// ─── Estado interno ───────────────────────────────────────────────────────────
// acumulador: ip -> { up: Number, down: Number }
const accumulator = new Map();
let flushing = false;  // guard contra flush concorrente

// cache DHCP: ip -> { hostname, mac }
let leaseCache        = new Map();
let lastLeaseRefresh  = 0;
let routerIdentity    = null;

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

// ─── Cache de leases DHCP ─────────────────────────────────────────────────────
async function refreshLeases() {
  const now = Date.now();
  if (now - lastLeaseRefresh < LEASE_REFRESH_MS) return;
  // lastLeaseRefresh só é marcado após conexão bem-sucedida (dentro do try)

  const host     = process.env.MIKROTIK_HOST;
  const user     = process.env.MIKROTIK_USER;
  const password = process.env.MIKROTIK_PASS;
  const port     = parseInt(process.env.MIKROTIK_PORT || '8728', 10);

  if (!host || !user || !password) {
    logger.warn('[Netflow] MIKROTIK_HOST/USER/PASS não configurados — hostname não disponível');
    return;
  }

  let api;
  try {
    api = new RouterOSAPI({ host, user, password, port, timeout: 10 });
    await api.connect();
    lastLeaseRefresh = now;  // marca como atualizado apenas após conexão bem-sucedida

    const leases = await api.write('/ip/dhcp-server/lease/print', [
      '=.proplist=address,host-name,mac-address',
      '?status=bound'
    ]);

    if (!routerIdentity) {
      const identity = await api.write('/system/identity/print');
      routerIdentity = identity[0]?.name || null;
    }

    const newCache = new Map();
    for (const l of leases) {
      if (l.address) {
        newCache.set(l.address, {
          hostname: l['host-name'] || null,
          mac:      l['mac-address'] || null
        });
      }
    }
    leaseCache = newCache;
    logger.info(`[Netflow] Cache DHCP atualizado: ${newCache.size} leases`);

  } catch (err) {
    logger.warn(`[Netflow] Falha ao buscar leases DHCP: ${err.message}`);
    lastLeaseRefresh = 0;  // permite nova tentativa no próximo flush
  } finally {
    if (api) {
      try { api.disconnect(); } catch (_) {}
    }
  }
}

// ─── Flush ao banco ───────────────────────────────────────────────────────────
async function flush() {
  if (accumulator.size === 0) {
    logger.info('[Netflow] Flush: nenhum dado acumulado');
    return;
  }

  await refreshLeases();

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
  let _debugCount = 0;
  const collector = Collector(function onPacket(data) {
    try {
      // Debug temporário: loga os primeiros 3 pacotes completos
      if (_debugCount < 3) {
        _debugCount++;
        const flows = data.flows || data.flow;
        logger.info(`[Netflow] DEBUG pacote #${_debugCount}: version=${data.header?.version} flowCount=${Array.isArray(flows) ? flows.length : 'N/A'}`);
        if (Array.isArray(flows) && flows.length > 0) {
          logger.info(`[Netflow] DEBUG flow[0] keys: ${Object.keys(flows[0]).join(', ')}`);
          logger.info(`[Netflow] DEBUG flow[0]: ${JSON.stringify(flows[0])}`);
        }
      }
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

  // Primeiro refresh de leases após a inicialização do banco
  setTimeout(() => {
    lastLeaseRefresh = 0;  // força refresh imediato
    refreshLeases().catch(() => {});
  }, 5000);
}

module.exports = { startNetflowCollector };
