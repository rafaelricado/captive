'use strict';

const axios  = require('axios');
const logger = require('./logger');

const { getVendor } = require('mac-oui-lookup');

// ─── Cache em memória para fallback online ────────────────────────────────────
// Chave: prefixo OUI (primeiros 6 hex, maiúsculos, sem separadores)
const vendorCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// ─── Mapeamento fabricante → tipo de dispositivo ──────────────────────────────
// Ordem importa: entradas mais específicas primeiro
const TYPE_MAP = [
  // ── Impressoras ──────────────────────────────────────────────────────────
  {
    keywords: ['canon', 'epson', 'brother', 'ricoh', 'lexmark', 'xerox',
               'kyocera', 'konica', 'sharp', 'oki data', 'toshiba tec',
               'boca systems', 'zebra technologies', 'datamax'],
    type: 'printer', label: 'Impressora'
  },
  // ── Câmeras IP / CFTV ────────────────────────────────────────────────────
  {
    keywords: ['hikvision', 'dahua', 'axis communications', 'hanwha',
               'bosch security', 'pelco', 'vivotek', 'mobotix', 'avigilon',
               'uniview', 'tiandy', 'provision-isr'],
    type: 'camera', label: 'Câmera IP'
  },
  // ── Equipamentos de Rede ─────────────────────────────────────────────────
  {
    keywords: ['cisco', 'ubiquiti', 'tp-link', 'd-link', 'netgear',
               'mikrotik', 'juniper', 'aruba', 'ruckus', 'engenius',
               'zyxel', 'extreme networks', 'fortinet', 'palo alto',
               'peplink', 'cambium', 'cradlepoint', 'aerohive',
               'motorola solutions', 'zebra tech'],
    type: 'network', label: 'Equipamento de Rede'
  },
  // ── IoT / Embarcados ─────────────────────────────────────────────────────
  {
    keywords: ['espressif', 'raspberry pi', 'arduino', 'tuya',
               'particle industries', 'pycom', 'nordic semiconductor',
               'espressif systems'],
    type: 'iot', label: 'IoT / Embarcado'
  },
  // ── Smart TV / Media ─────────────────────────────────────────────────────
  {
    keywords: ['tcl', 'hisense', 'vizio', 'philips', 'tpv technology',
               'vestel', 'skyworth'],
    type: 'tv', label: 'Smart TV'
  },
  // ── Computadores / Notebooks ─────────────────────────────────────────────
  {
    keywords: ['intel', 'dell', 'hewlett-packard', 'hp inc', 'lenovo',
               'acer', 'asustek', 'gigabyte', 'micro-star', 'msi ',
               'realtek', 'hon hai', 'foxconn', 'wistron', 'compal',
               'quanta computer', 'pegatron', 'inventec',
               'western digital', 'seagate', 'kingston'],
    type: 'computer', label: 'Computador / Notebook'
  },
  // ── Celulares / Tablets ──────────────────────────────────────────────────
  // (Apple, Samsung, LG e Sony ficam aqui: em rede Wi-Fi hospitalar,
  //  a imensa maioria é smartphone/tablet)
  {
    keywords: ['apple', 'samsung', 'xiaomi', 'huawei', 'oneplus',
               'motorola mobility', 'lg electronics', 'oppo', 'vivo',
               'realme', 'nokia', 'sony mobile', 'hmd global', 'zte',
               'alcatel', 'amazon', 'google', 'microsoft'],
    type: 'mobile', label: 'Celular / Tablet'
  }
];

const DEVICE_TYPE_LABELS = {
  computer: 'Computador / Notebook',
  mobile:   'Celular / Tablet',
  printer:  'Impressora',
  network:  'Equipamento de Rede',
  camera:   'Câmera IP',
  tv:       'Smart TV',
  iot:      'IoT / Embarcado',
  unknown:  'Desconhecido'
};

// ─── Inferência de tipo a partir do nome do fabricante ────────────────────────
function inferDeviceType(vendor) {
  if (!vendor) return 'unknown';
  const lower = vendor.toLowerCase();
  for (const { keywords, type } of TYPE_MAP) {
    if (keywords.some(k => lower.includes(k))) return type;
  }
  return 'unknown';
}

// ─── Lookup offline (IEEE OUI embutido) ───────────────────────────────────────
function lookupVendorOffline(mac) {
  try {
    return getVendor(mac) || null;
  } catch (_) {
    return null;
  }
}

// ─── Lookup online via macvendors.com (fallback) ─────────────────────────────
// Gratuito: 1.000 req/dia, sem chave de API.
// Só é chamado quando o banco offline não encontrou o fabricante.
async function lookupVendorOnline(mac) {
  const prefix = mac.replace(/[^0-9A-Fa-f]/g, '').substring(0, 6).toUpperCase();
  const cached = vendorCache.get(prefix);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.vendor;

  try {
    const segment = mac.substring(0, 8); // "XX:XX:XX"
    const resp = await axios.get(
      `https://api.macvendors.com/${encodeURIComponent(segment)}`,
      { timeout: 5000 }
    );
    const vendor = typeof resp.data === 'string' ? resp.data.trim() : null;
    vendorCache.set(prefix, { vendor, ts: Date.now() });
    return vendor;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      vendorCache.set(prefix, { vendor: null, ts: Date.now() });
      return null;
    }
    if (err.response && err.response.status === 429) {
      logger.warn('[OUI] Rate limit da API macvendors.com atingido.');
      return null;
    }
    logger.warn(`[OUI] Falha ao consultar macvendors.com para ${mac}: ${err.message}`);
    return null;
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Retorna { vendor, device_type } para um MAC address.
 * Tenta o banco offline primeiro; se não encontrar, consulta a API online.
 */
async function identify(mac) {
  if (!mac) return { vendor: null, device_type: 'unknown' };

  let vendor = lookupVendorOffline(mac);

  if (!vendor) {
    vendor = await lookupVendorOnline(mac);
  }

  const device_type = inferDeviceType(vendor);
  return { vendor: vendor || null, device_type };
}

module.exports = { identify, inferDeviceType, DEVICE_TYPE_LABELS };
