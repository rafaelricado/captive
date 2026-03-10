const { Op, fn, col } = require('sequelize');
const { TasyConta } = require('../../models');
const { queryOcupacaoHospitalar } = require('../../services/tasyService');
const logger = require('../../utils/logger');

// GET /admin/tasy/ocupacao
exports.ocupacao = async (req, res) => {
  try {
    // ── 1. Dados em tempo real do Oracle ────────────────────────────────
    let oracleData = null;
    let oracleError = null;
    try {
      oracleData = await queryOcupacaoHospitalar();
    } catch (err) {
      oracleError = err.message;
      logger.warn(`[TasyOcupacao] Oracle indisponível: ${err.message}`);
    }

    // ── 2. Dados complementares do PostgreSQL local ──────────────────────
    const hoje = new Date().toISOString().slice(0, 10);

    // Filtro base: apenas internações
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

    // ── 3. Pós-processamento ─────────────────────────────────────────────
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

    // Internados: calcular dias se qt_dias_conta nulo
    const internados = internadosLista.map(r => {
      let dias = r.qt_dias_conta;
      if (dias == null && r.dt_entrada) {
        dias = Math.max(0, Math.round((Date.now() - new Date(r.dt_entrada).getTime()) / 86400000));
      }
      return { ...r, dias_internado: dias || 0 };
    });

    const setoresFiltro = [...new Set(internados.map(i => i.ds_setor || '(Sem setor)'))].sort();

    res.render('admin/tasy_ocupacao', {
      page:          'tasy',
      // Oracle em tempo real
      oracleData,
      oracleError,
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
      page:      'tasy',
      erro:      err.message,
      csrfToken: req.session.csrfToken,
    });
  }
};
