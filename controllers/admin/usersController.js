const { Op } = require('sequelize');
const { User, Session } = require('../../models');
const mikrotikService = require('../../services/mikrotikService');
const logger = require('../../utils/logger');
const { audit } = require('../../utils/auditLogger');
const { PAGE_SIZE, DISPLAY_TIMEZONE, maskCpf, formatDate, escapeCSV } = require('./helpers');

exports.users = async (req, res) => {
  try {
    const page   = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const search = (req.query.search || '').trim();

    const where = search ? {
      [Op.or]: [
        { nome_completo: { [Op.iLike]: `%${search}%` } },
        { cpf:           { [Op.iLike]: `%${search}%` } },
        { email:         { [Op.iLike]: `%${search}%` } }
      ]
    } : {};

    const { count, rows } = await User.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: PAGE_SIZE,
      offset
    });

    const users = rows.map(u => ({
      id:              u.id,
      nome_completo:   u.nome_completo,
      cpf:             maskCpf(u.cpf),
      email:           u.email,
      telefone:        u.telefone,
      cidade:          u.cidade ? `${u.cidade}/${u.estado}` : '—',
      data_nascimento: u.data_nascimento || '—',
      nome_mae:        u.nome_mae || '—',
      created_at:      formatDate(u.created_at)
    }));

    res.render('admin/users', {
      users, search, page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total: count,
      pageLabel: page + 1,
      pageObj: 'users'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar usuários: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.exportUsers = async (req, res) => {
  try {
    const users = await User.findAll({ order: [['created_at', 'DESC']] });

    const header = 'Nome,CPF,Email,Telefone,Cidade,UF,Nascimento,Nome Mae,Cadastro';
    const rows = users.map(u => [
      u.nome_completo, u.cpf, u.email, u.telefone,
      u.cidade || '', u.estado || '',
      u.data_nascimento || '', u.nome_mae || '',
      new Date(u.created_at).toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE })
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usuarios_${date}.csv"`);
    logger.info(`[Admin] Exportação de usuários: ${users.length} registros`);
    audit('users.export', { count: users.length, ip: req.ip });
    res.send('\uFEFF' + header + '\n' + rows.join('\n'));
  } catch (err) {
    logger.error(`[Admin] Erro ao exportar usuários: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.redirect('/admin/users');

    await mikrotikService.removeUser(user.cpf, true);
    await Session.destroy({ where: { user_id: user.id } });
    await user.destroy();

    logger.info(`[Admin] Usuário excluído (LGPD): ${user.cpf}`);
    audit('user.delete', { userId: user.id, ip: req.ip });
    res.redirect('/admin/users');
  } catch (err) {
    logger.error(`[Admin] Erro ao excluir usuário: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};
