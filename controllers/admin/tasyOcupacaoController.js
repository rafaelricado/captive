const { Op, fn, col } = require('sequelize');
const { TasyConta } = require('../../models');
const { queryOcupacaoHospitalar } = require('../../services/tasyService');
const logger = require('../../utils/logger');

// Cache em memória: evita consultar Oracle a cada acesso
const ORACLE_TTL_MS = 2 * 60 * 1000; // 2 minutos
const oracleCache = { data: null, ts: 0, error: null };

// Cache dos agregados PG (mudam só na sync a cada 6h)
const PG_TTL_MS = 5 * 60 * 1000; // 5 minutos
const pgCache = { data: null, ts: 0 };

// GET /admin/tasy/ocupacao
exports.ocupacao = async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();

    // ── 1. Dados em tempo real do Oracle (com cache) ─────────────────────
    let oracleData = null;
    let oracleError = null;
    let oracleCached = false;

    if (!forceRefresh && oracleCache.data && (now - oracleCache.ts) < ORACLE_TTL_MS) {
      oracleData = oracleCache.data;
      oracleCached = true;
    } else {
      try {
        oracleData = await queryOcupacaoHospitalar();
        oracleCache.data = oracleData;
        oracleCache.ts   = now;
        oracleCache.error = null;
      } catch (err) {
        oracleError = err.message;
        oracleCache.error = err.message;
        // Serve dados antigos se disponíveis
        if (oracleCache.data) {
          oracleData = oracleCache.data;
          oracleCached = true;
          logger.warn(`[TasyOcupacao] Oracle falhou — usando cache de ${Math.round((now - oracleCache.ts) / 60000)}min atrás`);
        } else {
          logger.warn(`[TasyOcupacao] Oracle indisponível: ${err.message}`);
        }
      }
    }

    // ── 2. Dados complementares do PostgreSQL local (com cache) ──────────
    const hoje = new Date().toISOString().slice(0, 10);
    let pgData = null;

    if (!forceRefresh && pgCache.data && (now - pgCache.ts) < PG_TTL_MS) {
      pgData = pgCache.data;
    } else {
      const whereInternado = { status_categoria: 'aberto', ds_tipo_atendimento: 'Internado' };

      const [
        totalAtivos,
        altasHoje,
        permMedia,
        porConvenio,
        porEspecialidade,
        internadosLista,
      ] = await Promise.all([
        TasyConta.count({ where: whereInternado }),

        TasyConta.count({
          where: {
            dt_saida: hoje,
            ds_tipo_atendimento: 'Internado',
            status_categoria: { [Op.in]: ['faturado', 'outro'] },
          },
        }),

        TasyConta.findOne({
          attributes: [[fn('AVG', col('qt_dias_conta')), 'media']],
          where: {
            qt_dias_conta: { [Op.gt]: 0 },
            ds_tipo_atendimento: 'Internado',
            status_categoria: { [Op.in]: ['aberto', 'faturado'] },
          },
          raw: true,
        }),

        TasyConta.findAll({
          attributes: ['ds_convenio', [fn('COUNT', col('id')), 'qt']],
          where: whereInternado,
          group: ['ds_convenio'],
          order: [[fn('COUNT', col('id')), 'DESC']],
          limit: 10,
          raw: true,
        }),

        TasyConta.findAll({
          attributes: ['ds_especialidade', [fn('COUNT', col('id')), 'qt']],
          where: { ...whereInternado, ds_especialidade: { [Op.ne]: null } },
          group: ['ds_especialidade'],
          order: [[fn('COUNT', col('id')), 'DESC']],
          limit: 8,
          raw: true,
        }),

        TasyConta.findAll({
          attributes: [
            'nr_atendimento', 'nm_paciente', 'ds_setor', 'ds_convenio',
            'ds_tipo_atendimento', 'nm_medico', 'ds_especialidade',
            'dt_entrada', 'qt_dias_conta', 'ie_tipo_atend_tiss',
          ],
          where: whereInternado,
          order: [['dt_entrada', 'ASC']],
          limit: 300,
          raw: true,
        }),
      ]);

      const permMediaDias = permMedia?.media != null
        ? Number(permMedia.media).toFixed(1)
        : null;

      const convenios = porConvenio.map(r => ({
        nome: r.ds_convenio || '(Sem convênio)',
        qt:   Number(r.qt),
      }));

      const especialidades = porEspecialidade.map(r => ({
        nome: r.ds_especialidade,
        qt:   Number(r.qt),
      }));

      const internadosMapped = internadosLista.map(r => {
        let dias = r.qt_dias_conta;
        if (dias == null && r.dt_entrada) {
          dias = Math.max(0, Math.round((Date.now() - new Date(r.dt_entrada).getTime()) / 86400000));
        }
        return { ...r, dias_internado: dias || 0 };
      });

      pgData = { totalAtivos, altasHoje, permMediaDias, convenios, especialidades, internados: internadosMapped };
      pgCache.data = pgData;
      pgCache.ts   = now;
    }

    // ── 3. Pós-processamento ─────────────────────────────────────────────
    const { totalAtivos, altasHoje, permMediaDias, convenios, especialidades, internados } = pgData;
    const setoresFiltro = [...new Set(internados.map(i => i.ds_setor || '(Sem setor)'))].sort();

    const oracleCacheAge = oracleCached && oracleCache.ts
      ? Math.round((now - oracleCache.ts) / 60000)
      : null;

    res.render('admin/tasy_ocupacao', {
      page:          'tasy-ocupacao',
      // Oracle em tempo real
      oracleData,
      oracleError,
      oracleCached,
      oracleCacheAge,
      // PG local
      totalAtivos,
      altasHoje,
      permMediaDias,
      convenios,
      especialidades,
      internados,
      setoresFiltro,
      csrfToken:     req.session.csrfToken,
    });
  } catch (err) {
    logger.error(`[TasyOcupacao] ${err.message}`);
    res.status(500).render('admin/tasy_alertas_erro', {
      page:      'tasy-ocupacao',
      erro:      err.message,
      csrfToken: req.session.csrfToken,
    });
  }
};
