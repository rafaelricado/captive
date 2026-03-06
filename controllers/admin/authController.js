const bcrypt = require('bcryptjs');
const logger = require('../../utils/logger');
const { audit } = require('../../utils/auditLogger');

// hashSync é seguro aqui: roda uma única vez na inicialização, não bloqueia
// requisições porque o módulo é carregado antes do servidor aceitar conexões.
const _adminPasswordHash = process.env.ADMIN_PASSWORD
  ? bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12)
  : null;

exports.showLogin = (req, res) => {
  if (req.session && req.session.adminLoggedIn) {
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: null, username: '' });
};

exports.login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.render('admin/login', { error: 'Usuário e senha são obrigatórios.', username: '' });
  }
  if (username.length > 255 || password.length > 255) {
    return res.render('admin/login', { error: 'Valores inválidos.', username: '' });
  }

  const adminUser = process.env.ADMIN_USER;
  if (!adminUser || !_adminPasswordHash) {
    return res.render('admin/login', {
      error: 'ADMIN_USER ou ADMIN_PASSWORD não configurado no .env',
      username: ''
    });
  }

  try {
    const usernameOk = username === adminUser;
    const passwordOk = await bcrypt.compare(password, _adminPasswordHash);

    if (usernameOk && passwordOk) {
      req.session.regenerate(err => {
        if (err) {
          return res.render('admin/login', { error: 'Erro ao criar sessão.', username });
        }
        req.session.adminLoggedIn = true;
        logger.info(`[Admin] Login bem-sucedido: ${username} (${req.ip})`);
        audit('admin.login', { username, ip: req.ip });
        res.redirect('/admin');
      });
      return;
    }

    logger.warn(`[Admin] Falha de login para usuário "${username}" (${req.ip})`);
    res.render('admin/login', { error: 'Usuário ou senha incorretos.', username });
  } catch (err) {
    logger.error(`[Admin] Erro no login: ${err.message}`);
    res.render('admin/login', { error: 'Erro interno. Tente novamente.', username });
  }
};

exports.logout = (req, res) => {
  audit('admin.logout', { ip: req.ip });
  req.session.destroy(err => {
    if (err) logger.warn(`[Admin] Erro ao destruir sessão: ${err.message}`);
    res.redirect('/admin/login');
  });
};
