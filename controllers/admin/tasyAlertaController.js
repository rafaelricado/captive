const { Op } = require('sequelize');
const { TasyConta, TasyProtocolo } = require('../../models');
const { queryItensSemValor } = require('../../services/tasyService');
const logger = require('../../utils/logger');

// Mapa cd_convenio → nome (do TasyProtocolo local)
async function buildConvenioMap() {
  const rows = await TasyProtocolo.findAll({
    attributes: ['cd_convenio', 'ds_nome_convenio'],
    where: { cd_convenio: { [Op.ne]: null } },
    group: ['cd_convenio', 'ds_nome_convenio'],
    raw: true,
  });
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.cd_convenio)) {
      map.set(r.cd_convenio, r.ds_nome_convenio || `Conv. #${r.cd_convenio}`);
    }
  }
  return map;
}

// GET /admin/tasy/alertas
exports.alertas = async (req, res) => {
  try {
    const { dtInicio, dtFim, cdConvenio } = req.query;

    const [result, convenioMap] = await Promise.all([
      queryItensSemValor({ dtInicio, dtFim, cdConvenio }),
      buildConvenioMap(),
    ]);

    // Enriquecer resumo com nome do convênio
    const resumo = result.resumo.map(r => ({
      ...r,
      ds_nome_convenio: convenioMap.get(r.cd_convenio) || `Conv. #${r.cd_convenio}`,
    }));

    // Enriquecer itens com nome do convênio e buscar pacientes no PG local
    const nrAtendSet = [...new Set(result.itens.map(i => String(i.nr_atendimento)))];
    const contasLocais = nrAtendSet.length
      ? await TasyConta.findAll({
          attributes: ['nr_atendimento', 'nm_paciente', 'ds_convenio'],
          where: { nr_atendimento: { [Op.in]: nrAtendSet } },
          raw: true,
        })
      : [];
    const contaMap = new Map(contasLocais.map(c => [c.nr_atendimento, c]));

    const itens = result.itens.map(i => {
      const local = contaMap.get(String(i.nr_atendimento));
      return {
        ...i,
        nm_paciente:      local?.nm_paciente  || '—',
        ds_convenio_nome: convenioMap.get(i.cd_convenio) || local?.ds_convenio || `Conv. #${i.cd_convenio}`,
      };
    });

    // Totais
    const totAtend = resumo.reduce((s, r) => s + r.qt_atend, 0);
    const totItens = resumo.reduce((s, r) => s + r.qt_itens, 0);

    // Lista de convênios para o filtro
    const conveniosFiltro = [...convenioMap.entries()]
      .map(([cd, nome]) => ({ cd, nome }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    res.render('admin/tasy_alertas', {
      page:         'tasy',
      resumo,
      itens,
      totAtend,
      totItens,
      dtInicio:     result.dtInicio,
      dtFim:        result.dtFim,
      conveniosFiltro,
      truncated:    itens.length >= 1000,
      filters:      req.query,
      csrfToken:    req.session.csrfToken,
    });
  } catch (err) {
    logger.error(`[TasyAlerta] alertas: ${err.message}`);
    res.status(500).render('admin/tasy_alertas_erro', {
      page: 'tasy',
      erro: err.message,
      csrfToken: req.session.csrfToken,
    });
  }
};
