const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { User, Session, Setting, AccessPoint } = require('../models');
const mikrotikService = require('../services/mikrotikService');
const { pingAllAccessPoints, isValidIPv4 } = require('../services/pingService');

// Comparação de strings em tempo constante (previne timing attacks)
function safeEqual(a, b) {
  const key = process.env.SESSION_SECRET || 'internal-key';
  const ha = crypto.createHmac('sha256', key).update(String(a)).digest();
  const hb = crypto.createHmac('sha256', key).update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const PAGE_SIZE = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskCpf(cpf) {
  // 12345678901 → ***.456.789-01
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

function formatDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek() {
  const d = new Date();
  const day = d.getDay(); // 0=Dom, 1=Seg, ..., 6=Sáb
  const diff = day === 0 ? 6 : day - 1; // dias desde a segunda-feira
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Login ────────────────────────────────────────────────────────────────────

exports.showLogin = (req, res) => {
  if (req.session && req.session.adminLoggedIn) {
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: null, username: '' });
};

exports.login = (req, res) => {
  const { username, password } = req.body;

  // Validação de entrada
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.render('admin/login', { error: 'Usuário e senha são obrigatórios.', username: '' });
  }
  if (username.length > 255 || password.length > 255) {
    return res.render('admin/login', { error: 'Valores inválidos.', username: '' });
  }

  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminUser || !adminPassword) {
    return res.render('admin/login', {
      error: 'ADMIN_USER ou ADMIN_PASSWORD não configurado no .env',
      username: ''
    });
  }

  if (safeEqual(username, adminUser) && safeEqual(password, adminPassword)) {
    // Regenerar ID de sessão para prevenir session fixation
    req.session.regenerate(err => {
      if (err) {
        return res.render('admin/login', { error: 'Erro ao criar sessão.', username });
      }
      req.session.adminLoggedIn = true;
      res.redirect('/admin');
    });
    return;
  }

  res.render('admin/login', { error: 'Usuário ou senha incorretos.', username });
};

exports.logout = (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
};

// ─── Dashboard ────────────────────────────────────────────────────────────────

exports.dashboard = async (req, res) => {
  try {
    const now = new Date();

    const [totalUsers, activeSessions, novosHoje, novosSemana] = await Promise.all([
      User.count(),
      Session.count({
        where: { active: true, expires_at: { [Op.gt]: now } }
      }),
      User.count({
        where: { created_at: { [Op.gte]: startOfDay() } }
      }),
      User.count({
        where: { created_at: { [Op.gte]: startOfWeek() } }
      })
    ]);

    res.render('admin/dashboard', {
      totalUsers,
      activeSessions,
      novosHoje,
      novosSemana,
      page: 'dashboard'
    });
  } catch (err) {
    console.error('[Admin] Erro no dashboard:', err.message);
    res.status(500).send('Erro interno.');
  }
};

// ─── Usuários ─────────────────────────────────────────────────────────────────

exports.users = async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const search = (req.query.search || '').trim();

    const where = search ? {
      [Op.or]: [
        { nome_completo: { [Op.iLike]: `%${search}%` } },
        { cpf: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } }
      ]
    } : {};

    const { count, rows } = await User.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: PAGE_SIZE,
      offset
    });

    const users = rows.map(u => ({
      id: u.id,
      nome_completo: u.nome_completo,
      cpf: maskCpf(u.cpf),
      email: u.email,
      telefone: u.telefone,
      cidade: u.cidade ? `${u.cidade}/${u.estado}` : '—',
      data_nascimento: u.data_nascimento || '—',
      nome_mae: u.nome_mae || '—',
      created_at: formatDate(u.created_at)
    }));

    res.render('admin/users', {
      users,
      search,
      page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total: count,
      pageLabel: page + 1,
      pageObj: 'users'
    });
  } catch (err) {
    console.error('[Admin] Erro ao listar usuários:', err.message);
    res.status(500).send('Erro interno.');
  }
};

exports.exportUsers = async (req, res) => {
  try {
    const users = await User.findAll({ order: [['created_at', 'DESC']] });

    const escapeCSV = (val) => {
      if (val == null) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    const header = 'Nome,CPF,Email,Telefone,Cidade,UF,Nascimento,Nome Mae,Cadastro';
    const rows = users.map(u => [
      u.nome_completo, u.cpf, u.email, u.telefone,
      u.cidade || '', u.estado || '',
      u.data_nascimento || '', u.nome_mae || '',
      new Date(u.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usuarios_${date}.csv"`);
    res.send('\uFEFF' + header + '\n' + rows.join('\n'));
  } catch (err) {
    console.error('[Admin] Erro ao exportar usuários:', err.message);
    res.status(500).send('Erro interno.');
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.redirect('/admin/users');

    await mikrotikService.removeUser(user.cpf, true); // fullDelete: remove hotspot user (LGPD)
    await Session.destroy({ where: { user_id: user.id } });
    await user.destroy();

    console.log(`[Admin] Usuário ${user.cpf} excluído.`);
    res.redirect('/admin/users');
  } catch (err) {
    console.error('[Admin] Erro ao excluir usuário:', err.message);
    res.status(500).send('Erro interno.');
  }
};

// ─── Sessões ──────────────────────────────────────────────────────────────────

exports.sessions = async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const now = new Date();

    const { count, rows } = await Session.findAndCountAll({
      include: [{ model: User, attributes: ['nome_completo'] }],
      distinct: true,
      order: [['started_at', 'DESC']],
      limit: PAGE_SIZE,
      offset
    });

    const sessions = rows.map(s => ({
      id: s.id,
      nome: s.User ? s.User.nome_completo : '—',
      ip: s.ip_address || '—',
      mac: s.mac_address || '—',
      started_at: formatDate(s.started_at),
      expires_at: formatDate(s.expires_at),
      status: s.active && new Date(s.expires_at) > now ? 'Ativa' : 'Expirada'
    }));

    res.render('admin/sessions', {
      sessions,
      page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total: count,
      pageLabel: page + 1,
      pageObj: 'sessions'
    });
  } catch (err) {
    console.error('[Admin] Erro ao listar sessões:', err.message);
    res.status(500).send('Erro interno.');
  }
};

exports.terminateSession = async (req, res) => {
  try {
    const session = await Session.findByPk(req.params.id, {
      include: [{ model: User, attributes: ['cpf'] }]
    });
    if (!session || !session.active) return res.redirect('/admin/sessions');

    await mikrotikService.removeUser(session.User.cpf);
    session.active = false;
    await session.save();

    console.log(`[Admin] Sessão ${session.id} encerrada manualmente.`);
    res.redirect('/admin/sessions');
  } catch (err) {
    console.error('[Admin] Erro ao encerrar sessão:', err.message);
    res.status(500).send('Erro interno.');
  }
};

// ─── Configurações ────────────────────────────────────────────────────────────

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

async function fetchAllSettings() {
  const [orgName, orgLogo, sessionDuration, bgColor1, bgColor2] = await Promise.all([
    Setting.get('organization_name', 'Captive Portal'),
    Setting.get('organization_logo', ''),
    Setting.getSessionDuration(),
    Setting.get('portal_bg_color_1', '#0d4e8b'),
    Setting.get('portal_bg_color_2', '#1a7bc4')
  ]);
  return { orgName, orgLogo, sessionDuration, bgColor1, bgColor2 };
}

exports.showSettings = async (req, res) => {
  try {
    const s = await fetchAllSettings();
    res.render('admin/settings', { ...s, page: 'settings', success: null, error: null });
  } catch (err) {
    console.error('[Admin] Erro ao carregar configurações:', err.message);
    res.status(500).send('Erro interno.');
  }
};

exports.saveSettings = async (req, res) => {
  const renderSettings = async (success, error) => {
    const s = await fetchAllSettings();
    res.render('admin/settings', { ...s, page: 'settings', success, error });
  };

  try {
    const { organization_name, session_duration_hours, remove_logo, portal_bg_color_1, portal_bg_color_2 } = req.body;

    if (organization_name && organization_name.trim()) {
      await Setting.set('organization_name', organization_name.trim());
    }

    const hours = parseInt(session_duration_hours, 10);
    if (isNaN(hours) || hours < 1 || hours > 720) {
      return await renderSettings(null, 'Duração da sessão inválida. Informe um valor entre 1 e 720 horas.');
    }
    await Setting.set('session_duration_hours', String(hours));

    if (!HEX_COLOR_RE.test(portal_bg_color_1) || !HEX_COLOR_RE.test(portal_bg_color_2)) {
      return await renderSettings(null, 'Cor inválida. Use o seletor de cor ou o formato #RRGGBB.');
    }
    await Setting.set('portal_bg_color_1', portal_bg_color_1);
    await Setting.set('portal_bg_color_2', portal_bg_color_2);

    if (remove_logo === '1') {
      const oldLogo = await Setting.get('organization_logo', '');
      if (oldLogo) {
        const oldPath = path.join(__dirname, '../public', oldLogo);
        try { fs.unlinkSync(oldPath); } catch (_) { /* arquivo já removido */ }
      }
      await Setting.set('organization_logo', '');
    } else if (req.file) {
      const oldLogo = await Setting.get('organization_logo', '');
      if (oldLogo) {
        const oldPath = path.join(__dirname, '../public', oldLogo);
        try { fs.unlinkSync(oldPath); } catch (_) { /* arquivo já removido */ }
      }
      await Setting.set('organization_logo', `/uploads/logo/${req.file.filename}`);
    }

    console.log('[Admin] Configurações atualizadas');
    await renderSettings('Configurações salvas com sucesso.', null);
  } catch (err) {
    console.error('[Admin] Erro ao salvar configurações:', err.message);
    await renderSettings(null, 'Erro ao salvar as configurações. Tente novamente.');
  }
};

// ─── Pontos de Acesso ─────────────────────────────────────────────────────────

exports.accessPoints = async (req, res) => {
  try {
    const aps = await AccessPoint.findAll({ order: [['name', 'ASC']] });

    const list = aps.map(ap => ({
      id: ap.id,
      name: ap.name,
      ip_address: ap.ip_address,
      location: ap.location || '—',
      active: ap.active,
      is_online: ap.is_online,
      latency_ms: ap.latency_ms,
      last_checked_at: ap.last_checked_at ? formatDate(ap.last_checked_at) : 'Nunca',
      status: ap.is_online === null ? 'unknown' : (ap.is_online ? 'online' : 'offline')
    }));

    const online = list.filter(a => a.is_online === true).length;
    const offline = list.filter(a => a.is_online === false).length;
    const unknown = list.filter(a => a.is_online === null).length;

    const success = req.query.success ? 'Ponto de acesso adicionado com sucesso.' : null;
    const error = req.query.error ? decodeURIComponent(String(req.query.error)) : null;

    res.render('admin/access-points', {
      aps: list, online, offline, unknown,
      page: 'access-points',
      pageObj: 'access-points',
      error,
      success
    });
  } catch (err) {
    console.error('[Admin] Erro ao listar APs:', err.message);
    res.status(500).send('Erro interno.');
  }
};

exports.saveAccessPoint = async (req, res) => {
  const { name, ip_address, location } = req.body;
  try {
    if (!name || !name.trim()) {
      return res.redirect('/admin/access-points?error=Nome+obrigatorio');
    }
    if (!ip_address || !isValidIPv4(ip_address.trim())) {
      return res.redirect('/admin/access-points?error=IP+invalido');
    }

    await AccessPoint.create({
      name: name.trim(),
      ip_address: ip_address.trim(),
      location: location && location.trim() ? location.trim() : null
    });

    console.log(`[Admin] AP adicionado: ${name.trim()} (${ip_address.trim()})`);
    res.redirect('/admin/access-points?success=1');
  } catch (err) {
    console.error('[Admin] Erro ao salvar AP:', err.message);
    res.redirect('/admin/access-points?error=Erro+ao+salvar');
  }
};

exports.deleteAccessPoint = async (req, res) => {
  try {
    const ap = await AccessPoint.findByPk(req.params.id);
    if (ap) {
      console.log(`[Admin] AP removido: ${ap.name} (${ap.ip_address})`);
      await ap.destroy();
    }
    res.redirect('/admin/access-points');
  } catch (err) {
    console.error('[Admin] Erro ao excluir AP:', err.message);
    res.status(500).send('Erro interno.');
  }
};

exports.pingAccessPoints = async (req, res) => {
  try {
    const results = await pingAllAccessPoints();
    res.json({ ok: true, results, checked_at: new Date().toISOString() });
  } catch (err) {
    console.error('[Admin] Erro ao pingar APs:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
