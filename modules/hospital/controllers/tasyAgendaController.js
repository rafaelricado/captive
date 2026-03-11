const { queryAgendaConsulta } = require('../services/tasyService');
const logger = require('../../../utils/logger');

// Cache em memória: Oracle consultado no máximo a cada 2 minutos
const ORACLE_TTL_MS = 2 * 60 * 1000;
const oracleCache   = { data: null, ts: 0, dtInicio: null, dtFim: null };

// GET /admin/tasy/agenda
exports.agenda = async (req, res) => {
  try {
    const hoje         = new Date().toISOString().slice(0, 10);
    const dtInicio     = req.query.dtInicio || hoje;
    const dtFim        = req.query.dtFim   || hoje;
    const forceRefresh = req.query.refresh === '1';
    const now          = Date.now();

    let oracleData  = null;
    let oracleError = null;
    let oracleCached = false;

    // Cache só vale se período for o mesmo
    const mesmoFiltro = oracleCache.dtInicio === dtInicio && oracleCache.dtFim === dtFim;

    if (!forceRefresh && mesmoFiltro && oracleCache.data && (now - oracleCache.ts) < ORACLE_TTL_MS) {
      oracleData   = oracleCache.data;
      oracleCached = true;
    } else {
      try {
        oracleData = await queryAgendaConsulta({ dtInicio, dtFim });
        oracleCache.data     = oracleData;
        oracleCache.ts       = now;
        oracleCache.dtInicio = dtInicio;
        oracleCache.dtFim    = dtFim;
        oracleCache.error    = null;
      } catch (err) {
        oracleError = err.message;
        if (mesmoFiltro && oracleCache.data) {
          oracleData   = oracleCache.data;
          oracleCached = true;
          logger.warn(`[TasyAgenda] Oracle falhou — usando cache de ${Math.round((now - oracleCache.ts) / 60000)}min atrás`);
        } else {
          logger.warn(`[TasyAgenda] Oracle indisponível: ${err.message}`);
        }
      }
    }

    const oracleCacheAge = oracleCached && oracleCache.ts
      ? Math.round((now - oracleCache.ts) / 60000)
      : null;

    res.render('admin/tasy_agenda', {
      page:          'tasy-agenda',
      oracleData,
      oracleError,
      oracleCached,
      oracleCacheAge,
      dtInicio,
      dtFim,
      csrfToken: req.session.csrfToken,
    });
  } catch (err) {
    logger.error(`[TasyAgenda] ${err.message}`);
    res.status(500).render('admin/tasy_alertas_erro', {
      page:      'tasy-agenda',
      erro:      err.message,
      csrfToken: req.session.csrfToken,
    });
  }
};
