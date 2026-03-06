const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const adminAuth = require('../middleware/adminAuth');
const { csrfMiddleware, verifyCsrf } = require('../middleware/csrfProtection');
const adminController = require('../controllers/adminController');
const { Setting, SecurityEvent, sequelize } = require('../models');
const { Op } = require('sequelize');

// Diretório de upload garantido pelo startup em server.js
const uploadsDir = path.join(__dirname, '../public/uploads/logo');

// Multer: armazenamento de logo
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `logo_${Date.now()}${ext}`);
  }
});

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const ALLOWED_MIMETYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
// SVG excluído: pode conter JavaScript executável

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error('Formato não suportado. Use JPG, PNG, GIF ou WebP.'));
    }
    if (!ALLOWED_MIMETYPES.includes(file.mimetype)) {
      return cb(new Error('Tipo de arquivo inválido.'));
    }
    cb(null, true);
  }
});

// Rate limit: máximo 5 tentativas de login admin em 15 minutos por IP
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res.render('admin/login', {
      error: 'Muitas tentativas de login. Aguarde 15 minutos.',
      username: ''
    });
  }
});

// Cache simples do badge de segurança — evita query JSONB em cada requisição admin
let _securityCountCache = { value: 0, expiresAt: 0 };
function invalidateSecurityCount() { _securityCountCache.expiresAt = 0; }
async function getSecurityUnreadCount() {
  if (Date.now() < _securityCountCache.expiresAt) return _securityCountCache.value;
  const value = await SecurityEvent.count({
    where: {
      acknowledged: false,
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
      ]
    }
  });
  _securityCountCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

// Middleware: injeta configurações de marca em res.locals para todas as rotas admin
router.use(async (req, res, next) => {
  try {
    res.locals.orgName = await Setting.get('organization_name', 'Captive Portal');
    res.locals.orgLogo = await Setting.get('organization_logo', '');
    res.locals.securityUnreadCount = await getSecurityUnreadCount();
  } catch (_) {
    res.locals.orgName = 'Captive Portal';
    res.locals.orgLogo = '';
    res.locals.securityUnreadCount = 0;
  }
  next();
});

// Login (público)
router.get('/login', adminController.showLogin);
router.post('/login', adminLoginLimiter, adminController.login);
router.post('/logout', verifyCsrf, adminController.logout);

// Middleware CSRF em todas as rotas GET protegidas
router.use(adminAuth, csrfMiddleware);

// Painel (protegido)
router.get('/', adminAuth, adminController.dashboard);
router.get('/users', adminAuth, adminController.users);
router.get('/users/export', adminAuth, adminController.exportUsers);
router.post('/users/:id/delete', adminAuth, verifyCsrf, adminController.deleteUser);
router.get('/sessions', adminAuth, adminController.sessions);
router.get('/sessions/export', adminAuth, adminController.exportSessions);
router.post('/sessions/:id/terminate', adminAuth, verifyCsrf, adminController.terminateSession);

// Pontos de acesso (protegido)
// IMPORTANTE: rota /ping deve vir antes de /:id/* para não ser capturada pelo param
router.get('/access-points', adminAuth, adminController.accessPoints);
router.post('/access-points/ping', adminAuth, verifyCsrf, adminController.pingAccessPoints);
router.get('/access-points/:id/history', adminAuth, adminController.apHistory);
router.post('/access-points', adminAuth, verifyCsrf, adminController.saveAccessPoint);
router.post('/access-points/:id/delete', adminAuth, verifyCsrf, adminController.deleteAccessPoint);

// Rede / Tráfego Mikrotik (protegido)
router.get('/traffic', adminAuth, adminController.traffic);
router.get('/traffic/export', adminAuth, adminController.exportTraffic);
router.get('/wan', adminAuth, adminController.wan);
router.get('/connections', adminAuth, adminController.connections);
router.get('/dns', adminAuth, adminController.dns);

// Histórico de dispositivos (protegido)
// IMPORTANTE: rota estática '/devices' deve vir antes de '/devices/:mac'
router.get('/devices',        adminAuth, adminController.devices);
router.get('/devices/export', adminAuth, adminController.exportDevices);
router.get('/devices/:mac',   adminAuth, adminController.deviceDetail);

// IPs Gerenciados (protegido)
// IMPORTANTE: rotas estáticas devem vir antes de /:id/*
router.get('/managed-ips',                     adminAuth, adminController.managedIps);
router.post('/managed-ips',                    adminAuth, verifyCsrf, adminController.saveManagedIp);
router.get('/managed-ips/arp-table',           adminAuth, adminController.arpTable);
router.get('/managed-ips/:id',                 adminAuth, adminController.managedIpDetail);
router.post('/managed-ips/:id',                adminAuth, verifyCsrf, adminController.saveManagedIp);
router.post('/managed-ips/:id/delete',         adminAuth, verifyCsrf, adminController.deleteManagedIp);
router.get('/managed-ips/:id/live',            adminAuth, adminController.managedIpLive);
router.post('/managed-ips/:id/sync',           adminAuth, verifyCsrf, adminController.syncManagedIp);
router.post('/managed-ips/:id/identify',       adminAuth, verifyCsrf, adminController.identifyManagedIp);

// Endpoints JSON para auto-refresh das páginas (protegido)
router.get('/traffic/data', adminAuth, adminController.trafficData);
router.get('/wan/data', adminAuth, adminController.wanData);
router.get('/connections/data', adminAuth, adminController.connectionsData);

// Segurança — Eventos detectados (protegido)
// IMPORTANTE: rotas estáticas devem vir antes de /:id/*
router.get('/security', adminAuth, adminController.security);
router.get('/security/data', adminAuth, adminController.securityData);
router.get('/security/export', adminAuth, adminController.securityExport);
router.post('/security/acknowledge-all', adminAuth, verifyCsrf, adminController.acknowledgeAllSecurityEvents);
router.post('/security/:id/acknowledge', adminAuth, verifyCsrf, adminController.acknowledgeSecurityEvent);

// Configurações (protegido)
router.get('/settings', adminAuth, adminController.showSettings);
router.post('/settings/test-webhook', adminAuth, adminController.testWebhook);
router.post('/settings', adminAuth, verifyCsrf, (req, res, next) => {
  upload.single('organization_logo')(req, res, async err => {
    if (err instanceof multer.MulterError || err) {
      let bgColor1 = '#0d4e8b', bgColor2 = '#1a7bc4', sessionDuration = 48;
      let alertWebhookUrl = '';
      try {
        [bgColor1, bgColor2, sessionDuration, alertWebhookUrl] = await Promise.all([
          Setting.get('portal_bg_color_1', '#0d4e8b'),
          Setting.get('portal_bg_color_2', '#1a7bc4'),
          Setting.getSessionDuration(),
          Setting.get('alert_webhook_url', '')
        ]);
      } catch (_) { /* mantém os defaults acima */ }

      return res.render('admin/settings', {
        orgName: res.locals.orgName,
        orgLogo: res.locals.orgLogo,
        sessionDuration,
        bgColor1,
        bgColor2,
        alertWebhookUrl,
        page: 'settings',
        success: null,
        error: err.message || 'Erro ao processar o arquivo enviado.'
      });
    }
    next();
  });
}, adminController.saveSettings);

module.exports = router;
module.exports.invalidateSecurityCount = invalidateSecurityCount;
