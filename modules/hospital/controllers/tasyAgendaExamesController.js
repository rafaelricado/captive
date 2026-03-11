const { queryAgendaExames } = require('../services/tasyService');
const logger = require('../../../utils/logger');

// Cache em memória: Oracle consultado no máximo a cada 2 minutos
const ORACLE_TTL_MS = 2 * 60 * 1000;
const oracleCache   = { data: null, ts: 0, dtInicio: null, dtFim: null };

// GET /admin/tasy/agenda/exames
exports.agendaExames = async (req, res) => {
  try {
    const hoje         = new Date().toISOString().slice(0, 10);
    const d60          = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dtInicio     = req.query.dtInicio || d60;
    const dtFim        = req.query.dtFim   || hoje;
    const forceRefresh = req.query.refresh === '1';
    const now          = Date.now();

    let oracleData  = null;
    let oracleError = null;
    let oracleCached = false;

    const mesmoFiltro = oracleCache.dtInicio === dtInicio && oracleCache.dtFim === dtFim;

    if (!forceRefresh && mesmoFiltro && oracleCache.data && (now - oracleCache.ts) < ORACLE_TTL_MS) {
      oracleData   = oracleCache.data;
      oracleCached = true;
    } else {
      try {
        oracleData = await queryAgendaExames({ dtInicio, dtFim });
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
          logger.warn(`[TasyAgendaExames] Oracle falhou — usando cache de ${Math.round((now - oracleCache.ts) / 60000)}min atrás`);
        } else {
          logger.warn(`[TasyAgendaExames] Oracle indisponível: ${err.message}`);
        }
      }
    }

    const oracleCacheAge = oracleCached && oracleCache.ts
      ? Math.round((now - oracleCache.ts) / 60000)
      : null;

    res.render('admin/tasy_agenda_exames', {
      page:          'tasy-agenda-exames',
      oracleData,
      oracleError,
      oracleCached,
      oracleCacheAge,
      dtInicio,
      dtFim,
      csrfToken: req.session.csrfToken,
    });
  } catch (err) {
    logger.error(`[TasyAgendaExames] ${err.message}`);
    res.status(500).render('admin/tasy_alertas_erro', {
      page:      'tasy-agenda-exames',
      erro:      err.message,
      csrfToken: req.session.csrfToken,
    });
  }
};
