/**
 * Cache TTL simples em memória para settings do banco.
 * Reduz queries repetidas ao PostgreSQL nas rotas de portal.
 */
const store = new Map();
const DEFAULT_TTL_MS = 60 * 1000; // 1 minuto

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function set(key, value, ttl = DEFAULT_TTL_MS) {
  store.set(key, { value, expiresAt: Date.now() + ttl });
}

/** Invalida uma chave específica ou todo o cache (sem argumentos). */
function invalidate(key) {
  if (key !== undefined) {
    store.delete(key);
  } else {
    store.clear();
  }
}

module.exports = { get, set, invalidate };
