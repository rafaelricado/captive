const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { User, Session, Setting, AccessPoint, ApPingHistory,
  TrafficRanking, WanStat, ClientConnection, DnsEntry, sequelize } = require('../models');
const mikrotikService = require('../services/mikrotikService');
const { pingAllAccessPoints, isValidIPv4 } = require('../services/pingService');
const logger = require('../utils/logger');
const settingsCache = require('../utils/settingsCache');

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
  return new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
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

    const [totalUsers, activeSessions, novosHoje, novosSemana, wan24h, latestWanTime] = await Promise.all([
      User.count(),
      Session.count({ where: { active: true, expires_at: { [Op.gt]: now } } }),
      User.count({ where: { created_at: { [Op.gte]: startOfDay() } } }),
      User.count({ where: { created_at: { [Op.gte]: startOfWeek() } } }),
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
        interface_name: r.interface_name,
        volume:  formatBytes(Number(r.total_tx) + Number(r.total_rx)),
        uptime:  total > 0 ? Math.round((up / total) * 100) : null,
        is_up:   null
      };
    });
    wanLatest.forEach(r => {
      if (wanMap[r.interface_name]) {
        wanMap[r.interface_name].is_up = r.is_up;
      } else {
        wanMap[r.interface_name] = { interface_name: r.interface_name, volume: '—', uptime: null, is_up: r.is_up };
      }
    });
    const wanCards = Object.values(wanMap);

    res.render('admin/dashboard', {
      totalUsers, activeSessions, novosHoje, novosSemana, wanCards,
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
      new Date(u.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    ].map(escapeCSV).join(','));

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usuarios_${date}.csv"`);
    logger.info(`[Admin] Exportação de usuários: ${users.length} registros`);
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
      sessions, page,
      totalPages: Math.ceil(count / PAGE_SIZE),
      total: count,
      pageLabel: page + 1,
      pageObj: 'sessions'
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
  const [orgName, orgLogo, sessionDuration, bgColor1, bgColor2, alertWebhookUrl, mikrotikDataKey] = await Promise.all([
    Setting.get('organization_name', 'Captive Portal'),
    Setting.get('organization_logo', ''),
    Setting.getSessionDuration(),
    Setting.get('portal_bg_color_1', '#0d4e8b'),
    Setting.get('portal_bg_color_2', '#1a7bc4'),
    Setting.get('alert_webhook_url', ''),
    Setting.get('mikrotik_data_key', '')
  ]);
  return { orgName, orgLogo, sessionDuration, bgColor1, bgColor2, alertWebhookUrl, mikrotikDataKey };
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

    // Invalida cache de settings de marca (chave usada em utils/orgSettings.js)
    settingsCache.invalidate('org_settings');

    logger.info('[Admin] Configurações atualizadas');
    await renderSettings('Configurações salvas com sucesso.', null);
  } catch (err) {
    logger.error(`[Admin] Erro ao salvar configurações: ${err.message}`);
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
        interface_name: key,
        tx_total: 0,
        rx_total: 0,
        is_up: r.is_up,
        router_name: r.router_name || '—',
        latest_at: r.recorded_at
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
      interface_name: r.interface_name,
      tx: formatBytes(r.tx_total),
      rx: formatBytes(r.rx_total),
      is_up: r.is_up,
      router_name: r.router_name,
      recorded_at: formatDate(r.latest_at)
    }));

    const chartData = buildWanChart(rows);

    // Histórico: últimos 40 snapshots individuais para a tabela de histórico
    const history = rows.slice(0, 40).map(r => ({
      interface_name: r.interface_name,
      tx: formatBytes(Number(r.tx_bytes) || 0),
      rx: formatBytes(Number(r.rx_bytes) || 0),
      is_up: r.is_up,
      recorded_at: formatDate(r.recorded_at)
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
      interface_name: r.interface_name,
      tx:          formatBytes(r.tx_total),
      rx:          formatBytes(r.rx_total),
      is_up:       r.is_up,
      router_name: r.router_name,
      recorded_at: formatDate(r.latest_at)
    }));
    const chartData = buildWanChart(rows);
    const history = rows.slice(0, 40).map(r => ({
      interface_name: r.interface_name,
      tx: formatBytes(Number(r.tx_bytes) || 0),
      rx: formatBytes(Number(r.rx_bytes) || 0),
      is_up: r.is_up,
      recorded_at: formatDate(r.recorded_at)
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
