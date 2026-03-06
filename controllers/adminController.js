const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { Op, fn, col } = require('sequelize');
const { User, Session, Setting, AccessPoint, ApPingHistory,
  TrafficRanking, WanStat, ClientConnection, DnsEntry, SecurityEvent, DeviceHistory,
  ManagedIp, sequelize } = require('../models');
const mikrotikService = require('../services/mikrotikService');
const { pingAllAccessPoints, isValidIPv4 } = require('../services/pingService');
const logger = require('../utils/logger');
const { audit } = require('../utils/auditLogger');
const settingsCache = require('../utils/settingsCache');
const ouiLookup = require('../utils/ouiLookup');

const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE || 'America/Sao_Paulo';

// ─── Bcrypt: hash da senha admin gerado sincronamente na carga do módulo ──────
// hashSync é seguro aqui: roda uma única vez na inicialização, não bloqueia
// requisições porque o módulo é carregado antes do servidor aceitar conexões.
const _adminPasswordHash = process.env.ADMIN_PASSWORD
  ? bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12)
  : null;

const PAGE_SIZE = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskCpf(cpf) {
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

function formatDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE });
}

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return parseFloat((n / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function startOfWeek() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
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
    // Comparação em tempo constante via bcrypt
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

// ─── Dashboard ────────────────────────────────────────────────────────────────

exports.dashboard = async (req, res) => {
  try {
    const now = new Date();

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [totalUsers, activeSessions, novosHoje, novosSemana, totalDevices, registrosDiaRaw, wan24h, latestWanTime] = await Promise.all([
      User.count(),
      Session.count({ where: { active: true, expires_at: { [Op.gt]: now } } }),
      User.count({ where: { created_at: { [Op.gte]: startOfDay() } } }),
      User.count({ where: { created_at: { [Op.gte]: startOfWeek() } } }),
      DeviceHistory.count({ distinct: true, col: 'mac_address' }),
      User.findAll({
        attributes: [
          [fn('DATE', fn('timezone', DISPLAY_TIMEZONE, col('created_at'))), 'day'],
          [fn('COUNT', col('id')), 'count']
        ],
        where: { created_at: { [Op.gte]: since7d } },
        group: [fn('DATE', fn('timezone', DISPLAY_TIMEZONE, col('created_at')))],
        order: [[fn('DATE', fn('timezone', DISPLAY_TIMEZONE, col('created_at'))), 'ASC']],
        raw: true
      }),
      WanStat.findAll({
        attributes: [
          'interface_name',
          [sequelize.fn('SUM', sequelize.col('tx_bytes')), 'total_tx'],
          [sequelize.fn('SUM', sequelize.col('rx_bytes')), 'total_rx'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'total_records'],
          [sequelize.literal(`SUM(CASE WHEN is_up THEN 1 ELSE 0 END)`), 'up_count']
        ],
        where: { recorded_at: { [Op.gte]: since24h } },
        group: ['interface_name'],
        order: [['interface_name', 'ASC']],
        raw: true
      }),
      WanStat.max('recorded_at')
    ]);

    // Status atual de cada interface (snapshot mais recente)
    const wanLatest = latestWanTime
      ? await WanStat.findAll({ where: { recorded_at: latestWanTime }, raw: true })
      : [];

    // Combina agregado 24h + status atual
    const wanMap = {};
    wan24h.forEach(r => {
      const total = Number(r.total_records);
      const up    = Number(r.up_count);
      wanMap[r.interface_name] = {
        interface_name:  r.interface_name,
        volume:          formatBytes(Number(r.total_tx) + Number(r.total_rx)),
        uptime:          total > 0 ? Math.round((up / total) * 100) : null,
        is_up:           null,
        is_active_route: null
      };
    });
    wanLatest.forEach(r => {
      if (wanMap[r.interface_name]) {
        wanMap[r.interface_name].is_up           = r.is_up;
        wanMap[r.interface_name].is_active_route = r.is_active_route;
      } else {
        wanMap[r.interface_name] = {
          interface_name:  r.interface_name,
          volume:          '—',
          uptime:          null,
          is_up:           r.is_up,
          is_active_route: r.is_active_route
        };
      }
    });
    // Se há snapshot atual, remove entradas 24h com nomes antigos (fontes distintas podem
    // usar nomes diferentes, ex: "ether5" vs "Gardeline"). Mantém apenas as interfaces
    // presentes no snapshot mais recente para evitar cards duplicados.
    if (wanLatest.length > 0) {
      const currentIfaces = new Set(wanLatest.map(r => r.interface_name));
      Object.keys(wanMap).forEach(k => { if (!currentIfaces.has(k)) delete wanMap[k]; });
    }
    const wanCards = Object.values(wanMap);

    // Monta array de 7 dias com contagens de cadastros
    const registrosLabels = [];
    const registrosData   = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const label = d.toLocaleDateString('pt-BR', { timeZone: DISPLAY_TIMEZONE, day: '2-digit', month: '2-digit' });
      const dayStr = d.toLocaleDateString('en-CA', { timeZone: DISPLAY_TIMEZONE }); // YYYY-MM-DD
      const found = registrosDiaRaw.find(r => r.day === dayStr);
      registrosLabels.push(label);
      registrosData.push(found ? Number(found.count) : 0);
    }

    res.render('admin/dashboard', {
      totalUsers, activeSessions, novosHoje, novosSemana, totalDevices,
      registrosChart: { labels: registrosLabels, data: registrosData },
      wanCards,
      page: 'dashboard'
    });
  } catch (err) {
    logger.error(`[Admin] Erro no dashboard: ${err.message}`);
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

exports.exportSessions = async (req, res) => {
  try {
    const now = new Date();
    const rows = await Session.findAll({
      include: [{ model: User, attributes: ['nome_completo'] }],
      order: [['started_at', 'DESC']]
    });

    const escapeCSV = (val) => {
      if (val == null) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const header = 'Nome,IP,MAC,Inicio,Expiracao,Status';
    const lines = rows.map(s => [
      s.User ? s.User.nome_completo : '',
      s.ip_address || '', s.mac_address || '',
      new Date(s.started_at).toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE }),
      new Date(s.expires_at).toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE }),
      s.active && new Date(s.expires_at) > now ? 'Ativa' : 'Expirada'
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sessoes_${date}.csv"`);
    audit('sessions.export', { count: rows.length, ip: req.ip });
    res.send('\uFEFF' + header + '\n' + lines.join('\n'));
  } catch (err) {
    logger.error(`[Admin] Erro ao exportar sessões: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.exportDevices = async (req, res) => {
  try {
    const rows = await DeviceHistory.findAll({
      attributes: [
        'mac_address',
        [fn('MAX', col('hostname')),                     'hostname'],
        [fn('COUNT', fn('DISTINCT', col('ip_address'))), 'ip_count'],
        [fn('MIN', col('first_seen')),                   'first_seen'],
        [fn('MAX', col('last_seen')),                    'last_seen'],
        [fn('MAX', col('router_name')),                  'router_name']
      ],
      group: ['mac_address'],
      order: [[fn('MAX', col('last_seen')), 'DESC']],
      raw: true
    });

    const escapeCSV = (val) => {
      if (val == null) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const header = 'MAC,Hostname,IPs,Primeiro Acesso,Ultimo Acesso,Roteador';
    const lines = rows.map(d => [
      d.mac_address, d.hostname || '',
      Number(d.ip_count),
      new Date(d.first_seen).toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE }),
      new Date(d.last_seen).toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE }),
      d.router_name || ''
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dispositivos_${date}.csv"`);
    audit('devices.export', { count: rows.length, ip: req.ip });
    res.send('\uFEFF' + header + '\n' + lines.join('\n'));
  } catch (err) {
    logger.error(`[Admin] Erro ao exportar dispositivos: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.exportTraffic = async (req, res) => {
  try {
    const latest = await TrafficRanking.max('recorded_at');
    const rows = latest ? await TrafficRanking.findAll({
      where: { recorded_at: latest },
      order: [['bytes_down', 'DESC']],
      limit: 200
    }) : [];

    const escapeCSV = (val) => {
      if (val == null) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const header = 'IP,Hostname,MAC,Upload,Download,Total,Roteador';
    const lines = rows.map(r => [
      r.ip_address, r.hostname || '', r.mac_address || '',
      formatBytes(r.bytes_up), formatBytes(r.bytes_down),
      formatBytes(Number(r.bytes_up) + Number(r.bytes_down)),
      r.router_name || ''
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trafego_${date}.csv"`);
    audit('traffic.export', { count: rows.length, ip: req.ip });
    res.send('\uFEFF' + header + '\n' + lines.join('\n'));
  } catch (err) {
    logger.error(`[Admin] Erro ao exportar tráfego: ${err.message}`);
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

// ─── Sessões ──────────────────────────────────────────────────────────────────

exports.sessions = async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const now = new Date();
    const statusFilter = ['active', 'expired'].includes(req.query.status) ? req.query.status : '';

    const where = {};
    if (statusFilter === 'active')  { where.active = true;  where.expires_at = { [Op.gt]: now }; }
    if (statusFilter === 'expired') { where[Op.or] = [{ active: false }, { expires_at: { [Op.lte]: now } }]; }

    const [{ count, rows }, totalActive, totalExpired] = await Promise.all([
      Session.findAndCountAll({
        where,
        include: [{ model: User, attributes: ['nome_completo'] }],
        distinct: true,
        order: [['started_at', 'DESC']],
        limit: PAGE_SIZE,
        offset
      }),
      Session.count({ where: { active: true, expires_at: { [Op.gt]: now } } }),
      Session.count({ where: { [Op.or]: [{ active: false }, { expires_at: { [Op.lte]: now } }] } })
    ]);

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
      sessions, page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total: count,
      pageLabel: page + 1,
      pageObj: 'sessions',
      statusFilter,
      totalActive,
      totalExpired,
      totalAll: totalActive + totalExpired
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar sessões: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.terminateSession = async (req, res) => {
  try {
    const sess = await Session.findByPk(req.params.id, {
      include: [{ model: User, attributes: ['cpf'] }]
    });
    if (!sess || !sess.active) return res.redirect('/admin/sessions');

    await mikrotikService.removeUser(sess.User.cpf);
    sess.active = false;
    await sess.save();

    logger.info(`[Admin] Sessão ${sess.id} encerrada manualmente`);
    audit('session.terminate', { sessionId: sess.id, ip: req.ip });
    res.redirect('/admin/sessions');
  } catch (err) {
    logger.error(`[Admin] Erro ao encerrar sessão: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// ─── Configurações ────────────────────────────────────────────────────────────

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const URL_RE = /^https?:\/\/.+/;

function safeColor(val, fallback) {
  return HEX_COLOR_RE.test(val) ? val : fallback;
}

function isPrivateUrl(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) return true;
    if (/^10\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    return false;
  } catch (_) { return true; }
}

async function fetchAllSettings() {
  const [
    orgName, orgLogo, sessionDuration, bgColor1, bgColor2, alertWebhookUrl, mikrotikDataKey,
    securityWhitelistRaw, securityAnomalyWhitelistRaw, bruteForceThreshold, portScanThreshold,
    registerThreshold, dnsThreshold, anomalyStddev
  ] = await Promise.all([
    Setting.get('organization_name', 'Captive Portal'),
    Setting.get('organization_logo', ''),
    Setting.getSessionDuration(),
    Setting.get('portal_bg_color_1', '#0d4e8b'),
    Setting.get('portal_bg_color_2', '#1a7bc4'),
    Setting.get('alert_webhook_url', ''),
    Setting.get('mikrotik_data_key', ''),
    Setting.get('security_ip_whitelist', '[]'),
    Setting.get('security_anomaly_ip_whitelist', '[]'),
    Setting.get('security_brute_force_threshold', '5'),
    Setting.get('security_port_scan_threshold', '20'),
    Setting.get('security_register_threshold', '5'),
    Setting.get('security_dns_threshold', '50'),
    Setting.get('security_anomaly_stddev', '3')
  ]);

  let securityWhitelist = '';
  try {
    const arr = JSON.parse(securityWhitelistRaw);
    if (Array.isArray(arr)) securityWhitelist = arr.join('\n');
  } catch (_) {}

  let securityAnomalyWhitelist = '';
  try {
    const arr = JSON.parse(securityAnomalyWhitelistRaw);
    if (Array.isArray(arr)) securityAnomalyWhitelist = arr.join('\n');
  } catch (_) {}

  return {
    orgName, orgLogo, sessionDuration, bgColor1, bgColor2, alertWebhookUrl, mikrotikDataKey,
    securityWhitelist, securityAnomalyWhitelist, bruteForceThreshold, portScanThreshold,
    registerThreshold, dnsThreshold, anomalyStddev
  };
}

exports.showSettings = async (req, res) => {
  try {
    const s = await fetchAllSettings();
    res.render('admin/settings', { ...s, page: 'settings', success: null, error: null });
  } catch (err) {
    logger.error(`[Admin] Erro ao carregar configurações: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.saveSettings = async (req, res) => {
  const renderSettings = async (success, error) => {
    const s = await fetchAllSettings();
    res.render('admin/settings', { ...s, page: 'settings', success, error });
  };

  // Erro de upload propagado pelo middleware multer na rota
  if (req.uploadError) {
    return await renderSettings(null, req.uploadError);
  }

  try {
    const {
      organization_name, session_duration_hours,
      remove_logo, portal_bg_color_1, portal_bg_color_2,
      alert_webhook_url, mikrotik_data_key
    } = req.body;

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

    // Webhook de alertas (opcional)
    const webhookUrl = (alert_webhook_url || '').trim();
    if (webhookUrl) {
      if (!URL_RE.test(webhookUrl)) {
        return await renderSettings(null, 'URL do webhook inválida. Use http:// ou https://');
      }
      if (isPrivateUrl(webhookUrl)) {
        return await renderSettings(null, 'URL do webhook não pode apontar para endereços internos ou localhost.');
      }
    }
    await Setting.set('alert_webhook_url', webhookUrl);

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

    // Chave de ingestão Mikrotik (opcional — sobrescreve env se preenchida)
    await Setting.set('mikrotik_data_key', (mikrotik_data_key || '').trim());

    // ── Configurações de segurança ──
    const {
      security_ip_whitelist, security_anomaly_ip_whitelist,
      security_brute_force_threshold, security_port_scan_threshold,
      security_register_threshold, security_dns_threshold, security_anomaly_stddev
    } = req.body;

    // Whitelist helper: uma linha por IP, valida formato básico
    const IP_RE = /^[\d.a-fA-F:]{1,45}$/;
    function parseWhitelist(raw, label) {
      const lines = (raw || '').split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
      const invalid = lines.filter(ip => !IP_RE.test(ip));
      if (invalid.length > 0) throw new Error(`IP(s) inválido(s) na ${label}: ${invalid.slice(0, 3).join(', ')}`);
      if (lines.length > 100) throw new Error(`${label} não pode ter mais de 100 IPs.`);
      return lines;
    }
    let whitelistLines, anomalyWhitelistLines;
    try {
      whitelistLines        = parseWhitelist(security_ip_whitelist,         'whitelist global');
      anomalyWhitelistLines = parseWhitelist(security_anomaly_ip_whitelist, 'whitelist de anomalia');
    } catch (e) {
      return await renderSettings(null, e.message);
    }
    await Setting.set('security_ip_whitelist',         JSON.stringify(whitelistLines));
    await Setting.set('security_anomaly_ip_whitelist', JSON.stringify(anomalyWhitelistLines));

    // Thresholds: inteiros >= 1
    const thresholds = [
      ['security_brute_force_threshold', security_brute_force_threshold, 1, 10000],
      ['security_port_scan_threshold',   security_port_scan_threshold,   1, 10000],
      ['security_register_threshold',    security_register_threshold,    1, 10000],
      ['security_dns_threshold',         security_dns_threshold,         1, 10000]
    ];
    for (const [key, val, min, max] of thresholds) {
      const n = parseInt(val, 10);
      if (isNaN(n) || n < min || n > max) {
        return await renderSettings(null, `Limiar inválido para ${key}. Use um valor entre ${min} e ${max}.`);
      }
      await Setting.set(key, String(n));
    }

    // Fator de desvio padrão: float 1.0–10.0
    const stddev = parseFloat(security_anomaly_stddev);
    if (isNaN(stddev) || stddev < 1 || stddev > 10) {
      return await renderSettings(null, 'Fator de desvio padrão deve ser entre 1.0 e 10.0.');
    }
    await Setting.set('security_anomaly_stddev', String(stddev));

    // Invalida cache de settings de marca (chave usada em utils/orgSettings.js)
    settingsCache.invalidate('org_settings');

    logger.info('[Admin] Configurações atualizadas');
    audit('settings.update', { ip: req.ip });
    await renderSettings('Configurações salvas com sucesso.', null);
  } catch (err) {
    logger.error(`[Admin] Erro ao salvar configurações: ${err.message}`);
    await renderSettings(null, 'Erro ao salvar as configurações. Tente novamente.');
  }
};

exports.testWebhook = async (req, res) => {
  try {
    const webhookUrl = await Setting.get('alert_webhook_url', '');
    if (!webhookUrl) return res.json({ ok: false, error: 'Nenhuma URL de webhook configurada.' });
    if (!URL_RE.test(webhookUrl) || isPrivateUrl(webhookUrl)) {
      return res.json({ ok: false, error: 'URL de webhook inválida ou aponta para endereço interno.' });
    }
    const payload = JSON.stringify({
      event: 'test',
      message: 'Teste de webhook do Captive Portal',
      timestamp: new Date().toISOString()
    });
    const u = new URL(webhookUrl);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const httpReq = mod.request(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000
      }, resolve);
      httpReq.on('error', reject);
      httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('Timeout')); });
      httpReq.write(payload);
      httpReq.end();
    });
    logger.info('[Admin] Teste de webhook enviado com sucesso.');
    res.json({ ok: true });
  } catch (err) {
    logger.warn(`[Admin] Falha no teste de webhook: ${err.message}`);
    res.json({ ok: false, error: err.message });
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
      error, success
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar APs: ${err.message}`);
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

    logger.info(`[Admin] AP adicionado: ${name.trim()} (${ip_address.trim()})`);
    audit('ap.add', { name: name.trim(), ip: ip_address.trim(), adminIp: req.ip });
    res.redirect('/admin/access-points?success=1');
  } catch (err) {
    logger.error(`[Admin] Erro ao salvar AP: ${err.message}`);
    res.redirect('/admin/access-points?error=Erro+ao+salvar');
  }
};

exports.deleteAccessPoint = async (req, res) => {
  try {
    const ap = await AccessPoint.findByPk(req.params.id);
    if (ap) {
      logger.info(`[Admin] AP removido: ${ap.name} (${ap.ip_address})`);
      audit('ap.delete', { name: ap.name, ip: ap.ip_address, adminIp: req.ip });
      // Remove histórico de pings associado
      await ApPingHistory.destroy({ where: { ap_id: ap.id } });
      await ap.destroy();
    }
    res.redirect('/admin/access-points');
  } catch (err) {
    logger.error(`[Admin] Erro ao excluir AP: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.pingAccessPoints = async (req, res) => {
  try {
    const results = await pingAllAccessPoints();
    res.json({ ok: true, results, checked_at: new Date().toISOString() });
  } catch (err) {
    logger.error(`[Admin] Erro ao pingar APs: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
};

// Histórico de pings de um AP específico (JSON)
exports.apHistory = async (req, res) => {
  try {
    const ap = await AccessPoint.findByPk(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Ponto de acesso não encontrado.' });

    const history = await ApPingHistory.findAll({
      where: { ap_id: ap.id },
      order: [['checked_at', 'DESC']],
      limit: 100
    });

    res.json({
      ap: { id: ap.id, name: ap.name, ip_address: ap.ip_address },
      history: history.map(h => ({
        is_online: h.is_online,
        latency_ms: h.latency_ms,
        checked_at: h.checked_at
      }))
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao buscar histórico do AP: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

// ─── Tráfego de Clientes ──────────────────────────────────────────────────────

exports.traffic = async (req, res) => {
  try {
    // Pega o último snapshot: todos os registros do recorded_at mais recente
    const latest = await TrafficRanking.max('recorded_at');
    let clients = [];
    let updatedAt = null;

    if (latest) {
      const rows = await TrafficRanking.findAll({
        where: { recorded_at: latest },
        order: [['bytes_down', 'DESC']],
        limit: 200
      });
      updatedAt = formatDate(latest);
      clients = rows.map(r => ({
        ip_address: r.ip_address,
        hostname: r.hostname || '—',
        mac_address: r.mac_address || '—',
        bytes_up: formatBytes(r.bytes_up),
        bytes_down: formatBytes(r.bytes_down),
        total: formatBytes(Number(r.bytes_up) + Number(r.bytes_down)),
        router_name: r.router_name || '—'
      }));
    }

    res.render('admin/traffic', {
      clients, updatedAt,
      page: 'traffic',
      pageObj: 'traffic'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar tráfego: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// ─── Helpers DNS para resolução de IP → domínio ───────────────────────────────

async function buildDnsMap() {
  const rows = await DnsEntry.findAll({ raw: true });
  const map = {};
  for (const r of rows) {
    if (r.ip_address && !map[r.ip_address]) map[r.ip_address] = r.domain;
  }
  return map;
}

function resolveLabel(ip, dnsMap) {
  if (!ip) return ip;
  const domain = dnsMap[ip];
  if (!domain) return ip;
  // Remove subdomínios irrelevantes para exibir o serviço principal
  const parts = domain.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : domain;
}

// ─── Estatísticas WAN ─────────────────────────────────────────────────────────

function padZ(n) { return String(n).padStart(2, '0'); }

// Agrega os deltas das últimas 24h somando TX e RX por interface.
// Rows devem estar ordenadas por recorded_at DESC para que o primeiro
// registro de cada interface seja o mais recente (is_up / router_name).
function aggregateWanRows(rows) {
  const map = {};
  for (const r of rows) {
    const key = r.interface_name;
    if (!map[key]) {
      map[key] = {
        interface_name:  key,
        tx_total:        0,
        rx_total:        0,
        is_up:           r.is_up,
        is_active_route: r.is_active_route,
        router_name:     r.router_name || '—',
        latest_at:       r.recorded_at
      };
    }
    map[key].tx_total += Number(r.tx_bytes) || 0;
    map[key].rx_total += Number(r.rx_bytes) || 0;
  }
  return Object.values(map).sort((a, b) => a.interface_name.localeCompare(b.interface_name));
}

// Agrupa rows em buckets horários e produz datasets para Chart.js.
// Rows devem estar com raw:true. Retorna { labels, datasets }.
function buildWanChart(rows) {
  const map = {}; // "YYYY-MM-DD HH:00|iface" → {hour, iface, tx, rx}
  for (const r of rows) {
    const d = new Date(r.recorded_at);
    const h = `${d.getFullYear()}-${padZ(d.getMonth()+1)}-${padZ(d.getDate())} ${padZ(d.getHours())}:00`;
    const k = `${h}|${r.interface_name}`;
    if (!map[k]) map[k] = { hour: h, iface: r.interface_name, tx: 0, rx: 0 };
    map[k].tx += Number(r.tx_bytes) || 0;
    map[k].rx += Number(r.rx_bytes) || 0;
  }
  const entries = Object.values(map);
  const hours = [...new Set(entries.map(e => e.hour))].sort();
  const ifaces = [...new Set(entries.map(e => e.iface))].sort();
  const COLORS = [['#0d4e8b','#60a5fa'], ['#15803d','#4ade80']];
  const datasets = [];
  ifaces.forEach((iface, i) => {
    const [cRx, cTx] = COLORS[i] || ['#888','#aaa'];
    datasets.push({
      label: `${iface} ↓RX`,
      data: hours.map(h => { const e = map[`${h}|${iface}`]; return e ? +(e.rx/1024/1024).toFixed(2) : 0; }),
      borderColor: cRx, backgroundColor: cRx + '25', fill: true, tension: 0.3, borderWidth: 2
    });
    datasets.push({
      label: `${iface} ↑TX`,
      data: hours.map(h => { const e = map[`${h}|${iface}`]; return e ? +(e.tx/1024/1024).toFixed(2) : 0; }),
      borderColor: cTx, backgroundColor: 'transparent', fill: false, tension: 0.3, borderWidth: 1.5, borderDash: [5,3]
    });
  });
  return { labels: hours.map(h => h.slice(11,16)), datasets };
}

exports.wan = async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const rows = await WanStat.findAll({
      where: { recorded_at: { [Op.gte]: since } },
      order: [['recorded_at', 'DESC']],
      raw: true
    });

    const aggregated = aggregateWanRows(rows);
    const latestTs = aggregated.reduce((max, r) => (!max || r.latest_at > max ? r.latest_at : max), null);

    const stats = aggregated.map(r => ({
      interface_name:  r.interface_name,
      tx:              formatBytes(r.tx_total),
      rx:              formatBytes(r.rx_total),
      is_up:           r.is_up,
      is_active_route: r.is_active_route,
      router_name:     r.router_name,
      recorded_at:     formatDate(r.latest_at)
    }));

    const chartData = buildWanChart(rows);

    // Histórico: últimos 40 snapshots individuais para a tabela de histórico
    const history = rows.slice(0, 40).map(r => ({
      interface_name:  r.interface_name,
      tx:              formatBytes(Number(r.tx_bytes) || 0),
      rx:              formatBytes(Number(r.rx_bytes) || 0),
      is_up:           r.is_up,
      is_active_route: r.is_active_route,
      recorded_at:     formatDate(r.recorded_at)
    }));

    res.render('admin/wan', {
      stats,
      chartData,
      history,
      updatedAt: latestTs ? formatDate(latestTs) : null,
      page: 'wan',
      pageObj: 'wan'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar WAN: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// ─── Conexões Ativas ──────────────────────────────────────────────────────────

exports.connections = async (req, res) => {
  try {
    const latest = await ClientConnection.max('recorded_at');
    let connections = [];
    let updatedAt = null;

    if (latest) {
      const [rows, dnsMap] = await Promise.all([
        ClientConnection.findAll({ where: { recorded_at: latest }, order: [['bytes_orig', 'DESC']], limit: 200 }),
        buildDnsMap()
      ]);
      updatedAt = formatDate(latest);
      connections = rows.map(r => ({
        src_ip: r.src_ip,
        dst_ip: r.dst_ip,
        dst_label: resolveLabel(r.dst_ip, dnsMap),
        dst_port: r.dst_port,
        bytes_orig: formatBytes(r.bytes_orig),
        bytes_reply: formatBytes(r.bytes_reply),
        router_name: r.router_name || '—'
      }));
    }

    res.render('admin/connections', {
      connections, updatedAt,
      page: 'connections',
      pageObj: 'connections'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar conexões: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// ─── Cache DNS ────────────────────────────────────────────────────────────────

exports.dns = async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const q = (req.query.q || '').trim();

    const where = q ? {
      [Op.or]: [
        { domain: { [Op.iLike]: `%${q}%` } },
        { ip_address: { [Op.iLike]: `%${q}%` } }
      ]
    } : {};

    const { count, rows } = await DnsEntry.findAndCountAll({
      where,
      order: [['domain', 'ASC']],
      limit: PAGE_SIZE,
      offset
    });

    const latest = await DnsEntry.max('recorded_at');

    res.render('admin/dns', {
      entries: rows,
      q,
      page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total: count,
      pageLabel: page + 1,
      updatedAt: latest ? formatDate(latest) : null,
      pageObj: 'dns'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar DNS: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// ─── Histórico de Dispositivos ───────────────────────────────────────────────

const MAC_RE_STRICT = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

exports.devices = async (req, res) => {
  try {
    const page   = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const q      = (req.query.q || '').trim();

    const where = q ? {
      [Op.or]: [
        { mac_address: { [Op.iLike]: `%${q}%` } },
        { ip_address:  { [Op.iLike]: `%${q}%` } },
        { hostname:    { [Op.iLike]: `%${q}%` } }
      ]
    } : {};

    const latestTraffic = await TrafficRanking.max('recorded_at');
    const onlineMacs = new Set(
      latestTraffic
        ? (await TrafficRanking.findAll({
            where: { recorded_at: latestTraffic },
            attributes: ['mac_address'],
            raw: true
          })).map(r => r.mac_address).filter(Boolean)
        : []
    );

    const [devices, total] = await Promise.all([
      DeviceHistory.findAll({
        attributes: [
          'mac_address',
          [fn('MAX', col('hostname')),                          'hostname'],
          [fn('COUNT', fn('DISTINCT', col('ip_address'))),      'ip_count'],
          [fn('MIN', col('first_seen')),                        'first_seen'],
          [fn('MAX', col('last_seen')),                         'last_seen'],
          [fn('MAX', col('router_name')),                       'router_name']
        ],
        where,
        group: ['mac_address'],
        order: [[fn('MAX', col('last_seen')), 'DESC']],
        limit: PAGE_SIZE,
        offset,
        raw: true
      }),
      DeviceHistory.count({ distinct: true, col: 'mac_address', where })
    ]);

    res.render('admin/devices', {
      devices: devices.map(d => ({
        mac_address: d.mac_address,
        hostname:    d.hostname   || '—',
        ip_count:    Number(d.ip_count),
        first_seen:  formatDate(d.first_seen),
        last_seen:   formatDate(d.last_seen),
        router_name: d.router_name || '—',
        online:      onlineMacs.has(d.mac_address)
      })),
      q, page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      pageLabel: page + 1,
      pageObj: 'devices'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar dispositivos: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.deviceDetail = async (req, res) => {
  try {
    const mac = (req.params.mac || '').trim().toUpperCase();
    if (!MAC_RE_STRICT.test(mac)) return res.status(400).send('MAC inválido.');

    const entries = await DeviceHistory.findAll({
      where: { mac_address: mac },
      order: [['last_seen', 'DESC']],
      raw: true
    });

    if (entries.length === 0) return res.status(404).send('Dispositivo não encontrado.');

    const hostname = entries.find(e => e.hostname)?.hostname || mac;

    res.render('admin/device_detail', {
      mac,
      hostname,
      entries: entries.map(e => ({
        ip_address:  e.ip_address,
        hostname:    e.hostname    || '—',
        first_seen:  formatDate(e.first_seen),
        last_seen:   formatDate(e.last_seen),
        router_name: e.router_name || '—'
      })),
      pageObj: 'devices'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao detalhar dispositivo: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// ─── JSON para auto-refresh das páginas ───────────────────────────────────────

exports.trafficData = async (req, res) => {
  try {
    const latest = await TrafficRanking.max('recorded_at');
    let clients = [], updatedAt = null;
    if (latest) {
      const rows = await TrafficRanking.findAll({
        where: { recorded_at: latest }, order: [['bytes_down', 'DESC']], limit: 200
      });
      updatedAt = formatDate(latest);
      clients = rows.map(r => ({
        ip_address:  r.ip_address,
        hostname:    r.hostname    || '—',
        mac_address: r.mac_address || '—',
        bytes_up:    formatBytes(r.bytes_up),
        bytes_down:  formatBytes(r.bytes_down),
        total:       formatBytes(Number(r.bytes_up) + Number(r.bytes_down)),
        router_name: r.router_name || '—'
      }));
    }
    res.json({ clients, updatedAt });
  } catch (err) {
    logger.error(`[Admin] Erro em trafficData: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

exports.wanData = async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await WanStat.findAll({
      where: { recorded_at: { [Op.gte]: since } },
      order: [['recorded_at', 'DESC']],
      raw: true
    });
    const aggregated = aggregateWanRows(rows);
    const latestTs = aggregated.reduce((max, r) => (!max || r.latest_at > max ? r.latest_at : max), null);
    const stats = aggregated.map(r => ({
      interface_name:  r.interface_name,
      tx:              formatBytes(r.tx_total),
      rx:              formatBytes(r.rx_total),
      is_up:           r.is_up,
      is_active_route: r.is_active_route,
      router_name:     r.router_name,
      recorded_at:     formatDate(r.latest_at)
    }));
    const chartData = buildWanChart(rows);
    const history = rows.slice(0, 40).map(r => ({
      interface_name:  r.interface_name,
      tx:              formatBytes(Number(r.tx_bytes) || 0),
      rx:              formatBytes(Number(r.rx_bytes) || 0),
      is_up:           r.is_up,
      is_active_route: r.is_active_route,
      recorded_at:     formatDate(r.recorded_at)
    }));
    res.json({ stats, chartData, history, updatedAt: latestTs ? formatDate(latestTs) : null });
  } catch (err) {
    logger.error(`[Admin] Erro em wanData: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

exports.connectionsData = async (req, res) => {
  try {
    const latest = await ClientConnection.max('recorded_at');
    let connections = [], updatedAt = null;
    if (latest) {
      const [rows, dnsMap] = await Promise.all([
        ClientConnection.findAll({ where: { recorded_at: latest }, order: [['bytes_orig', 'DESC']], limit: 200 }),
        buildDnsMap()
      ]);
      updatedAt = formatDate(latest);
      connections = rows.map(r => ({
        src_ip:      r.src_ip,
        dst_ip:      r.dst_ip,
        dst_label:   resolveLabel(r.dst_ip, dnsMap),
        dst_port:    r.dst_port,
        bytes_orig:  formatBytes(r.bytes_orig),
        bytes_reply: formatBytes(r.bytes_reply),
        router_name: r.router_name || '—'
      }));
    }
    res.json({ connections, updatedAt });
  } catch (err) {
    logger.error(`[Admin] Erro em connectionsData: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

// ─── Segurança ────────────────────────────────────────────────────────────────

function formatEventType(type) {
  const map = { brute_force: 'Força Bruta', port_scan: 'Varredura de Portas', traffic_anomaly: 'Anomalia de Tráfego' };
  return map[type] || type;
}

function formatSeverity(s) {
  return { low: 'Baixa', medium: 'Média', high: 'Alta' }[s] || s;
}

function summarizeDetails(details) {
  if (!details) return '—';
  if (details.subtype === 'attempt')          return `Tentativa de login: ${details.reason || ''}`;
  if (details.subtype === 'register_attempt') return `Tentativa de cadastro: ${details.reason || ''}`;
  if (details.subtype === 'register_flood')   return `${details.attempt_count} cadastros repetidos em ${details.window_minutes || '?'} min`;
  if (details.subtype === 'dns_tunneling')    return `${details.dns_count} queries DNS em ${details.window_minutes || '?'} min`;
  if (details.subtype === 'mac_spoofing')     return `${details.mac_count} MACs distintos: ${(details.macs || []).join(', ')}`;
  if (details.subtype === 'correlation')      return `Múltiplos ataques: ${(details.event_types || []).join(', ')}`;
  if (details.attempt_count)  return `${details.attempt_count} tentativas em ${details.window_minutes || '?'} min`;
  if (details.distinct_ports) return `${details.distinct_ports} portas distintas em ${details.window_minutes || '?'} min`;
  if (details.bytes_down_mb)  return `${details.bytes_down_mb} MB baixados (${details.stddev_factor || '?'}× desvio padrão)`;
  return JSON.stringify(details).slice(0, 80);
}

function buildSecurityList(events) {
  return events.map(e => ({
    id: e.id,
    event_type: e.event_type,
    event_type_label: formatEventType(e.event_type),
    severity: e.severity,
    severity_label: formatSeverity(e.severity),
    src_ip: e.src_ip,
    details_summary: summarizeDetails(e.details),
    acknowledged: e.acknowledged,
    detected_at: formatDate(e.detected_at)
  }));
}

const SECURITY_RETENTION_DAYS = 30;
const VALID_EVENT_TYPES  = ['brute_force', 'port_scan', 'traffic_anomaly'];
const VALID_SEVERITIES   = ['low', 'medium', 'high'];
const VALID_PERIODS      = ['24h', '7d'];
const IP_FILTER_RE       = /^[\d.a-fA-F:]{1,45}$/;

function parseSecurityFilters(query) {
  return {
    type:     VALID_EVENT_TYPES.includes(query.type)     ? query.type     : '',
    severity: VALID_SEVERITIES.includes(query.severity)  ? query.severity : '',
    ip:       IP_FILTER_RE.test(query.ip || '')          ? query.ip       : '',
    period:   VALID_PERIODS.includes(query.period)       ? query.period   : ''
  };
}

async function fetchSecurityEvents(filters = {}) {
  const days = filters.period === '24h' ? 1 : SECURITY_RETENTION_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const where = {
    detected_at: { [Op.gte]: since },
    [Op.and]: [
      sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
      sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
    ]
  };
  if (filters.type)     where.event_type = filters.type;
  if (filters.severity) where.severity   = filters.severity;
  if (filters.ip)       where.src_ip     = filters.ip;

  return SecurityEvent.findAll({
    where,
    order: [['detected_at', 'DESC']],
    limit: 500
  });
}

// Agrega eventos dos últimos 7 dias por dia e por tipo para o gráfico
async function buildSecurityChart() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await SecurityEvent.findAll({
    attributes: [
      [sequelize.fn('DATE', sequelize.fn('timezone', DISPLAY_TIMEZONE, sequelize.col('detected_at'))), 'day'],
      'event_type',
      [sequelize.fn('COUNT', sequelize.col('id')), 'total']
    ],
    where: {
      detected_at: { [Op.gte]: since },
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
      ]
    },
    group: [
      sequelize.fn('DATE', sequelize.fn('timezone', DISPLAY_TIMEZONE, sequelize.col('detected_at'))),
      'event_type'
    ],
    order: [[sequelize.fn('DATE', sequelize.fn('timezone', DISPLAY_TIMEZONE, sequelize.col('detected_at'))), 'ASC']],
    raw: true
  });

  // Gera labels para os últimos 7 dias
  const labels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    labels.push(d.toLocaleDateString('pt-BR', { timeZone: DISPLAY_TIMEZONE, day: '2-digit', month: '2-digit' }));
  }

  const types = ['brute_force', 'port_scan', 'traffic_anomaly'];
  const datasets = {};
  types.forEach(t => { datasets[t] = new Array(7).fill(0); });

  rows.forEach(r => {
    const dayStr = new Date(r.day + 'T12:00:00Z').toLocaleDateString('pt-BR', { timeZone: DISPLAY_TIMEZONE, day: '2-digit', month: '2-digit' });
    const idx = labels.indexOf(dayStr);
    if (idx !== -1 && datasets[r.event_type]) {
      datasets[r.event_type][idx] = Number(r.total);
    }
  });

  return { labels, datasets };
}

// Agrega eventos das últimas 24h por hora e por tipo para o gráfico horário
async function buildSecurityHourlyChart() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await SecurityEvent.findAll({
    attributes: ['event_type', 'detected_at'],
    where: {
      detected_at: { [Op.gte]: since },
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
      ]
    },
    raw: true
  });

  // Gera slots horários para as últimas 24h (em UTC para matching)
  const nowHour = Math.floor(Date.now() / 3600000) * 3600000;
  const labels   = [];
  const slotKeys = [];
  for (let i = 23; i >= 0; i--) {
    const slotStart = new Date(nowHour - i * 3600000);
    labels.push(slotStart.toLocaleTimeString('pt-BR', { timeZone: DISPLAY_TIMEZONE, hour: '2-digit', minute: '2-digit' }));
    slotKeys.push(slotStart.toISOString().slice(0, 13)); // "YYYY-MM-DDTHH" UTC
  }

  const types = ['brute_force', 'port_scan', 'traffic_anomaly'];
  const datasets = {};
  types.forEach(t => { datasets[t] = new Array(24).fill(0); });

  rows.forEach(r => {
    const key = new Date(Math.floor(new Date(r.detected_at).getTime() / 3600000) * 3600000).toISOString().slice(0, 13);
    const idx = slotKeys.indexOf(key);
    if (idx !== -1 && datasets[r.event_type]) datasets[r.event_type][idx]++;
  });

  return { labels, datasets };
}

exports.security = async (req, res) => {
  try {
    const filters = parseSecurityFilters(req.query);
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString();
    const [events, chartData, hourlyChart] = await Promise.all([
      fetchSecurityEvents(filters), buildSecurityChart(), buildSecurityHourlyChart()
    ]);
    const list = buildSecurityList(events);
    const unacknowledgedCount = list.filter(e => !e.acknowledged).length;
    const counts = { brute_force: 0, port_scan: 0, traffic_anomaly: 0 };
    list.forEach(e => { if (counts[e.event_type] !== undefined) counts[e.event_type]++; });

    res.render('admin/security', {
      events: list, counts, unacknowledgedCount, chartData, hourlyChart,
      filters, queryString: qs,
      page: 'security', pageObj: 'security',
      csrfToken: res.locals.csrfToken
    });
  } catch (err) {
    logger.error(`[Admin] Erro na página de segurança: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.securityData = async (req, res) => {
  try {
    const filters = parseSecurityFilters(req.query);
    const [events, chartData, hourlyChart] = await Promise.all([
      fetchSecurityEvents(filters), buildSecurityChart(), buildSecurityHourlyChart()
    ]);
    const list = buildSecurityList(events);
    const unacknowledgedCount = list.filter(e => !e.acknowledged).length;
    const counts = { brute_force: 0, port_scan: 0, traffic_anomaly: 0 };
    list.forEach(e => { if (counts[e.event_type] !== undefined) counts[e.event_type]++; });
    res.json({ events: list, counts, unacknowledgedCount, chartData, hourlyChart });
  } catch (err) {
    logger.error(`[Admin] Erro em securityData: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

exports.securityExport = async (req, res) => {
  try {
    const filters = parseSecurityFilters(req.query);
    const events = await fetchSecurityEvents(filters);
    const list = buildSecurityList(events);

    const escapeCSV = (val) => {
      if (val == null) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const header = 'Detectado em,Tipo,Severidade,IP Origem,Detalhes,Status';
    const rows = list.map(e => [
      e.detected_at, e.event_type_label, e.severity_label,
      e.src_ip, e.details_summary, e.acknowledged ? 'Reconhecido' : 'Pendente'
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="seguranca_${date}.csv"`);
    audit('security.export', { count: list.length, ip: req.ip });
    res.send('\uFEFF' + header + '\n' + rows.join('\n'));
  } catch (err) {
    logger.error(`[Admin] Erro ao exportar segurança: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.acknowledgeSecurityEvent = async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.redirect('/admin/security');
  try {
    const event = await SecurityEvent.findByPk(req.params.id);
    if (!event) return res.redirect('/admin/security');
    event.acknowledged = true;
    await event.save();
    // Invalida o cache do badge no nav para refletir a mudança imediatamente
    try { require('../routes/admin').invalidateSecurityCount(); } catch (_) {}
    logger.info(`[Admin] Evento de segurança reconhecido: ${event.id} (${event.event_type} / ${event.src_ip})`);
    audit('security.acknowledge', { eventId: event.id, eventType: event.event_type, srcIp: event.src_ip, ip: req.ip });
    res.redirect('/admin/security');
  } catch (err) {
    logger.error(`[Admin] Erro ao reconhecer evento de segurança: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.acknowledgeAllSecurityEvents = async (req, res) => {
  try {
    // Aceita filtros do body (para "reconhecer visíveis") ou sem filtros (todos)
    const filters = parseSecurityFilters(req.body || {});
    const hasFilters = filters.type || filters.severity || filters.ip || filters.period;

    let where = {
      acknowledged: false,
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
      ]
    };

    if (hasFilters) {
      const days = filters.period === '24h' ? 1 : SECURITY_RETENTION_DAYS;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      where.detected_at = { [Op.gte]: since };
      if (filters.type)     where.event_type = filters.type;
      if (filters.severity) where.severity   = filters.severity;
      if (filters.ip)       where.src_ip     = filters.ip;
    }

    const [count] = await SecurityEvent.update({ acknowledged: true }, { where });
    try { require('../routes/admin').invalidateSecurityCount(); } catch (_) {}
    logger.info(`[Admin] ${count} evento(s) de segurança reconhecidos em massa.`);
    audit('security.acknowledge_all', { count, filters: hasFilters ? filters : 'all', ip: req.ip });

    // Preserva filtros na redirect
    const qs = hasFilters ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString() : '';
    res.redirect('/admin/security' + qs);
  } catch (err) {
    logger.error(`[Admin] Erro ao reconhecer todos os eventos: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// ─── IPs Gerenciados ──────────────────────────────────────────────────────────

exports.managedIps = async (req, res) => {
  try {
    const page   = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const q      = (req.query.q || '').trim();

    const where = q ? {
      [Op.or]: [
        { ip_address:  { [Op.iLike]: `%${q}%` } },
        { mac_address: { [Op.iLike]: `%${q}%` } },
        { hostname:    { [Op.iLike]: `%${q}%` } },
        { location:    { [Op.iLike]: `%${q}%` } },
        { department:  { [Op.iLike]: `%${q}%` } },
        { responsible: { [Op.iLike]: `%${q}%` } }
      ]
    } : {};

    const [ips, total] = await Promise.all([
      ManagedIp.findAll({ where, order: [[sequelize.literal('ip_address::inet'), 'ASC']], limit: PAGE_SIZE, offset, raw: true }),
      ManagedIp.count({ where })
    ]);

    const ipAddresses = ips.map(r => r.ip_address);
    const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [trafficRows, deviceRows] = ipAddresses.length > 0 ? await Promise.all([
      TrafficRanking.findAll({
        attributes: [
          'ip_address',
          [fn('SUM', col('bytes_up')),    'total_up'],
          [fn('SUM', col('bytes_down')),  'total_down'],
          [fn('MAX', col('recorded_at')), 'last_seen']
        ],
        where: { ip_address: { [Op.in]: ipAddresses }, recorded_at: { [Op.gte]: cutoff30 } },
        group: ['ip_address'],
        raw: true
      }),
      DeviceHistory.findAll({
        attributes: ['ip_address', [fn('MAX', col('last_seen')), 'last_seen_dev']],
        where: { ip_address: { [Op.in]: ipAddresses } },
        group: ['ip_address'],
        raw: true
      })
    ]) : [[], []];

    const trafficMap = Object.fromEntries(trafficRows.map(r => [r.ip_address, r]));
    const deviceMap  = Object.fromEntries(deviceRows.map(r => [r.ip_address, r]));

    res.render('admin/managed-ips', {
      ips: ips.map(ip => {
        const tr = trafficMap[ip.ip_address] || {};
        const dv = deviceMap[ip.ip_address]  || {};
        const lastSeenTs = tr.last_seen || dv.last_seen_dev;
        return {
          ...ip,
          total_up:      formatBytes(tr.total_up   || 0),
          total_down:    formatBytes(tr.total_down  || 0),
          total_traffic: formatBytes((Number(tr.total_up) || 0) + (Number(tr.total_down) || 0)),
          last_seen:     lastSeenTs ? formatDate(lastSeenTs) : '—'
        };
      }),
      q, page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      pageLabel: page + 1,
      pageObj: 'managed-ips'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao listar IPs gerenciados: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.managedIpDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const managed = await ManagedIp.findByPk(id, { raw: true });
    if (!managed) return res.status(404).send('IP não encontrado.');

    const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [trafficHistory, deviceEntries, connections] = await Promise.all([
      TrafficRanking.findAll({
        where: { ip_address: managed.ip_address, recorded_at: { [Op.gte]: cutoff30 } },
        order: [['recorded_at', 'DESC']],
        limit: 200,
        raw: true
      }),
      DeviceHistory.findAll({
        where: { ip_address: managed.ip_address },
        order: [['last_seen', 'DESC']],
        raw: true
      }),
      ClientConnection.findAll({
        where: { src_ip: managed.ip_address },
        order: [['recorded_at', 'DESC']],
        limit: 50,
        raw: true
      })
    ]);

    res.render('admin/managed-ip-detail', {
      managed,
      trafficHistory: trafficHistory.map(r => ({
        recorded_at: formatDate(r.recorded_at),
        hostname:    r.hostname    || '—',
        mac_address: r.mac_address || '—',
        bytes_up:    formatBytes(r.bytes_up),
        bytes_down:  formatBytes(r.bytes_down),
        total:       formatBytes(Number(r.bytes_up) + Number(r.bytes_down))
      })),
      deviceEntries: deviceEntries.map(e => ({
        mac_address: e.mac_address,
        hostname:    e.hostname    || '—',
        first_seen:  formatDate(e.first_seen),
        last_seen:   formatDate(e.last_seen),
        router_name: e.router_name || '—'
      })),
      connections: connections.map(c => ({
        src_ip:      c.src_ip,
        dst_ip:      c.dst_ip    || '—',
        dst_port:    c.dst_port  ?? '—',
        bytes_orig:  formatBytes(c.bytes_orig),
        bytes_reply: formatBytes(c.bytes_reply),
        recorded_at: formatDate(c.recorded_at)
      })),
      pageObj: 'managed-ips'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao detalhar IP gerenciado: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.saveManagedIp = async (req, res) => {
  try {
    const { id, ip_address, mac_address, hostname, location, department, responsible, notes, is_active } = req.body;

    if (!ip_address || !isValidIPv4(ip_address.trim())) {
      return res.redirect('/admin/managed-ips?toast=' + encodeURIComponent('IP inválido.') + '&toastType=error');
    }

    const mac = mac_address ? mac_address.trim().toUpperCase() : null;
    if (mac && !MAC_RE_STRICT.test(mac)) {
      return res.redirect('/admin/managed-ips?toast=' + encodeURIComponent('Endereço MAC inválido.') + '&toastType=error');
    }

    // Auto-identificação por MAC (offline + fallback online) se MAC foi informado
    // e o usuário não forçou um device_type manual
    const deviceTypeBody = req.body.device_type || null;
    let vendor      = req.body.vendor      ? req.body.vendor.trim().substring(0, 150) : null;
    let device_type = deviceTypeBody && deviceTypeBody !== 'unknown' ? deviceTypeBody : null;

    if (mac && !device_type) {
      const identified = await ouiLookup.identify(mac);
      if (identified.vendor)      vendor      = identified.vendor;
      if (identified.device_type) device_type = identified.device_type;
    }

    const data = {
      ip_address:  ip_address.trim(),
      mac_address: mac || null,
      hostname:    hostname    ? hostname.trim().substring(0, 255)    : null,
      location:    location    ? location.trim().substring(0, 255)    : null,
      department:  department  ? department.trim().substring(0, 100)  : null,
      responsible: responsible ? responsible.trim().substring(0, 100) : null,
      notes:       notes       ? notes.trim()                         : null,
      vendor:      vendor      || null,
      device_type: device_type || 'unknown',
      is_active:   is_active === 'true' || is_active === '1' || is_active === 'on'
    };

    if (id) {
      await ManagedIp.update(data, { where: { id } });
      logger.info(`[Admin] IP gerenciado atualizado: ${data.ip_address}`);
      return res.redirect('/admin/managed-ips/' + id + '?toast=' + encodeURIComponent('Salvo com sucesso.') + '&toastType=success');
    } else {
      const created = await ManagedIp.create(data);
      logger.info(`[Admin] IP gerenciado criado: ${data.ip_address}`);
      return res.redirect('/admin/managed-ips/' + created.id + '?toast=' + encodeURIComponent('IP cadastrado com sucesso.') + '&toastType=success');
    }
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.redirect('/admin/managed-ips?toast=' + encodeURIComponent('Este IP já está cadastrado.') + '&toastType=error');
    }
    logger.error(`[Admin] Erro ao salvar IP gerenciado: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.deleteManagedIp = async (req, res) => {
  try {
    const { id } = req.params;
    const managed = await ManagedIp.findByPk(id);
    if (!managed) return res.status(404).send('IP não encontrado.');
    const ip = managed.ip_address;
    await managed.destroy();
    logger.info(`[Admin] IP gerenciado removido: ${ip}`);
    res.redirect('/admin/managed-ips?toast=' + encodeURIComponent('IP removido.') + '&toastType=success');
  } catch (err) {
    logger.error(`[Admin] Erro ao remover IP gerenciado: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

// JSON: tabela ARP + leases DHCP do Mikrotik (para importação)
exports.arpTable = async (req, res) => {
  try {
    const [arpEntries, leases] = await Promise.all([
      mikrotikService.getArpTable(),
      mikrotikService.getDhcpLeases()
    ]);

    if (!arpEntries) {
      return res.status(503).json({ error: 'Não foi possível conectar ao Mikrotik.' });
    }

    const leaseMap = {};
    if (leases) {
      leases.forEach(l => { if (l.address) leaseMap[l.address] = l['host-name'] || null; });
    }

    const managed = await ManagedIp.findAll({ attributes: ['ip_address'], raw: true });
    const managedSet = new Set(managed.map(m => m.ip_address));

    const entries = arpEntries
      .filter(e =>
        e.address &&
        e['mac-address'] &&
        e.address !== '0.0.0.0' &&   // exclui entradas de bridge/proxy ARP sem IP real
        e.complete  !== 'false' &&    // exclui hosts que não responderam ao ARP
        e.disabled  !== 'true'        // exclui entradas desabilitadas manualmente
      )
      .map(e => ({
        ip:         e.address,
        mac:        e['mac-address'],
        hostname:   leaseMap[e.address] || null,
        interface:  e.interface         || null,
        is_managed: managedSet.has(e.address)
      }))
      .sort((a, b) => {
        // Ordena numericamente por IP
        const toNum = ip => ip.split('.').reduce((acc, o) => (acc * 256 + parseInt(o, 10)) >>> 0, 0);
        return toNum(a.ip) - toNum(b.ip);
      });

    res.json({ entries });
  } catch (err) {
    logger.error(`[Admin] Erro ao buscar tabela ARP: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

// JSON: dados live do Mikrotik para um IP gerenciado específico
exports.managedIpLive = async (req, res) => {
  try {
    const { id } = req.params;
    const managed = await ManagedIp.findByPk(id, { raw: true });
    if (!managed) return res.status(404).json({ error: 'IP não encontrado.' });

    const [arpEntries, leases] = await Promise.all([
      mikrotikService.getArpTable(),
      mikrotikService.getDhcpLeases()
    ]);

    const arp   = arpEntries ? arpEntries.find(e => e.address === managed.ip_address)  : null;
    const lease = leases     ? leases.find(l => l.address === managed.ip_address)       : null;

    res.json({
      arp: arp ? {
        mac:       arp['mac-address'],
        interface: arp.interface  || null,
        status:    arp.status     || null,
        complete:  arp.complete !== 'false'
      } : null,
      lease: lease ? {
        hostname:     lease['host-name']      || null,
        mac:          lease['mac-address']    || null,
        expires_after: lease['expires-after'] || null,
        server:       lease.server            || null
      } : null
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao buscar dados live do IP: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

// POST: sincroniza MAC e hostname de um IP gerenciado com o Mikrotik
exports.syncManagedIp = async (req, res) => {
  try {
    const { id } = req.params;
    const managed = await ManagedIp.findByPk(id);
    if (!managed) return res.status(404).json({ error: 'IP não encontrado.' });

    const [arpEntries, leases] = await Promise.all([
      mikrotikService.getArpTable(),
      mikrotikService.getDhcpLeases()
    ]);

    if (!arpEntries) {
      return res.status(503).json({ error: 'Sem conexão com Mikrotik.' });
    }

    const arp   = arpEntries.find(e => e.address === managed.ip_address);
    const lease = leases ? leases.find(l => l.address === managed.ip_address) : null;

    if (!arp) {
      return res.json({ ok: false, message: 'IP não encontrado na tabela ARP do Mikrotik.' });
    }

    const updates = {};
    if (arp['mac-address'])             updates.mac_address = arp['mac-address'];
    if (lease && lease['host-name'])    updates.hostname    = lease['host-name'];

    // Identificação do dispositivo pelo MAC obtido do Mikrotik
    const macForId = updates.mac_address || managed.mac_address;
    if (macForId) {
      const identified = await ouiLookup.identify(macForId);
      if (identified.vendor)                               updates.vendor      = identified.vendor;
      if (identified.device_type !== 'unknown')            updates.device_type = identified.device_type;
    }

    if (Object.keys(updates).length > 0) {
      await managed.update(updates);
      logger.info(`[Admin] IP gerenciado sincronizado com Mikrotik: ${managed.ip_address}`);
    }

    res.json({ ok: true, updates });
  } catch (err) {
    logger.error(`[Admin] Erro ao sincronizar IP gerenciado: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

// POST: identifica fabricante e tipo de dispositivo pelo MAC armazenado
exports.identifyManagedIp = async (req, res) => {
  try {
    const { id } = req.params;
    const managed = await ManagedIp.findByPk(id);
    if (!managed) return res.status(404).json({ error: 'IP não encontrado.' });

    if (!managed.mac_address) {
      return res.json({ ok: false, message: 'Sem MAC cadastrado. Sincronize com o Mikrotik primeiro.' });
    }

    const { vendor, device_type } = await ouiLookup.identify(managed.mac_address);
    const updates = { device_type: device_type || 'unknown' };
    if (vendor) updates.vendor = vendor;

    await managed.update(updates);
    logger.info(`[Admin] Dispositivo identificado: ${managed.ip_address} → ${vendor || 'desconhecido'} (${device_type})`);

    res.json({
      ok:          true,
      vendor:      updates.vendor      || null,
      device_type: updates.device_type,
      label:       ouiLookup.DEVICE_TYPE_LABELS[device_type] || 'Desconhecido'
    });
  } catch (err) {
    logger.error(`[Admin] Erro ao identificar dispositivo: ${err.message}`);
    res.status(500).json({ error: 'Erro interno.' });
  }
};
