const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const adminAuth = require('../middleware/adminAuth');
const { csrfMiddleware, verifyCsrf } = require('../middleware/csrfProtection');
const authController         = require('../controllers/admin/authController');
const dashboardController    = require('../controllers/admin/dashboardController');
const usersController        = require('../controllers/admin/usersController');
const sessionsController     = require('../controllers/admin/sessionsController');
const settingsController     = require('../controllers/admin/settingsController');
const accessPointsController = require('../controllers/admin/accessPointsController');
const networkController      = require('../controllers/admin/networkController');
const devicesController      = require('../controllers/admin/devicesController');
const securityController     = require('../controllers/admin/securityController');
const managedIpsController   = require('../controllers/admin/managedIpsController');
const tasyController         = require('../controllers/admin/tasyController');
const tasyProtocoloController = require('../controllers/admin/tasyProtocoloController');
const { Setting } = require('../models');
const securityCountCache = require('../utils/securityCountCache');

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

// Rate limit: exportações e endpoints de dados pesados — máximo 20 req/minuto por IP
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    if (req.accepts('json')) {
      return res.status(429).json({ error: 'Muitas requisições. Aguarde um momento.' });
    }
    res.status(429).send('Muitas requisições. Aguarde um momento.');
  }
});

// Middleware: injeta configurações de marca em res.locals para todas as rotas admin
router.use(async (req, res, next) => {
  try {
    res.locals.orgName = await Setting.get('organization_name', 'Captive Portal');
    res.locals.orgLogo = await Setting.get('organization_logo', '');
    res.locals.securityUnreadCount = await securityCountCache.getUnreadCount();
  } catch (_) {
    res.locals.orgName = 'Captive Portal';
    res.locals.orgLogo = '';
    res.locals.securityUnreadCount = 0;
  }
  next();
});

// Login (público)
router.get('/login', authController.showLogin);
router.post('/login', adminLoginLimiter, authController.login);
router.post('/logout', verifyCsrf, authController.logout);

// Middleware CSRF em todas as rotas GET protegidas
router.use(adminAuth, csrfMiddleware);

// Painel (protegido)
router.get('/', adminAuth, dashboardController.dashboard);
router.get('/users', adminAuth, usersController.users);
router.get('/users/export', adminAuth, exportLimiter, usersController.exportUsers);
router.post('/users/:id/delete', adminAuth, verifyCsrf, usersController.deleteUser);
router.get('/sessions', adminAuth, sessionsController.sessions);
router.get('/sessions/export', adminAuth, exportLimiter, sessionsController.exportSessions);
router.post('/sessions/:id/terminate', adminAuth, verifyCsrf, sessionsController.terminateSession);

// Pontos de acesso (protegido)
// IMPORTANTE: rota /ping deve vir antes de /:id/* para não ser capturada pelo param
router.get('/access-points', adminAuth, accessPointsController.accessPoints);
router.post('/access-points/ping', adminAuth, verifyCsrf, accessPointsController.pingAccessPoints);
router.get('/access-points/:id/history', adminAuth, accessPointsController.apHistory);
router.post('/access-points', adminAuth, verifyCsrf, accessPointsController.saveAccessPoint);
router.post('/access-points/:id/delete', adminAuth, verifyCsrf, accessPointsController.deleteAccessPoint);

// Rede / Tráfego Mikrotik (protegido)
router.get('/traffic', adminAuth, networkController.traffic);
router.get('/traffic/export', adminAuth, exportLimiter, networkController.exportTraffic);
router.get('/wan', adminAuth, networkController.wan);
router.get('/connections', adminAuth, networkController.connections);
router.get('/dns', adminAuth, networkController.dns);

// Histórico de dispositivos (protegido)
// IMPORTANTE: rota estática '/devices' deve vir antes de '/devices/:mac'
router.get('/devices',        adminAuth, devicesController.devices);
router.get('/devices/export', adminAuth, exportLimiter, devicesController.exportDevices);
router.get('/devices/:mac',   adminAuth, devicesController.deviceDetail);

// IPs Gerenciados (protegido)
// IMPORTANTE: rotas estáticas devem vir antes de /:id/*
router.get('/managed-ips',                     adminAuth, managedIpsController.managedIps);
router.post('/managed-ips',                    adminAuth, verifyCsrf, managedIpsController.saveManagedIp);
router.get('/managed-ips/arp-table',           adminAuth, managedIpsController.arpTable);
router.get('/managed-ips/:id',                 adminAuth, managedIpsController.managedIpDetail);
router.post('/managed-ips/:id',                adminAuth, verifyCsrf, managedIpsController.saveManagedIp);
router.post('/managed-ips/:id/delete',         adminAuth, verifyCsrf, managedIpsController.deleteManagedIp);
router.get('/managed-ips/:id/live',            adminAuth, managedIpsController.managedIpLive);
router.post('/managed-ips/:id/sync',           adminAuth, verifyCsrf, managedIpsController.syncManagedIp);
router.post('/managed-ips/:id/identify',       adminAuth, verifyCsrf, managedIpsController.identifyManagedIp);

// Endpoints JSON para auto-refresh das páginas (protegido)
router.get('/traffic/data', adminAuth, networkController.trafficData);
router.get('/wan/data', adminAuth, networkController.wanData);
router.get('/connections/data', adminAuth, networkController.connectionsData);

// Segurança — Eventos detectados (protegido)
// IMPORTANTE: rotas estáticas devem vir antes de /:id/*
router.get('/security', adminAuth, securityController.security);
router.get('/security/data', adminAuth, securityController.securityData);
router.get('/security/export', adminAuth, exportLimiter, securityController.securityExport);
router.post('/security/acknowledge-all', adminAuth, verifyCsrf, securityController.acknowledgeAllSecurityEvents);
router.post('/security/:id/acknowledge', adminAuth, verifyCsrf, securityController.acknowledgeSecurityEvent);

// Tasy — Contas de paciente (protegido)
router.get('/tasy',        adminAuth, tasyController.dashboard);
router.get('/tasy/data',   adminAuth, tasyController.data);
router.get('/tasy/export', adminAuth, exportLimiter, tasyController.export);
router.post('/tasy/sync',  adminAuth, verifyCsrf, tasyController.sync);

// Protocolo convênio
router.get ('/tasy/protocolos',              adminAuth, csrfMiddleware, tasyProtocoloController.list);
router.get ('/tasy/protocolos/preview',      adminAuth, tasyProtocoloController.preview);
router.post('/tasy/protocolos',              adminAuth, verifyCsrf,    tasyProtocoloController.criar);
router.post('/tasy/protocolos/:id/status',   adminAuth, verifyCsrf,    tasyProtocoloController.atualizarStatus);
router.delete('/tasy/protocolos/:id',        adminAuth, verifyCsrf,    tasyProtocoloController.excluir);

// Configurações (protegido)
router.get('/settings', adminAuth, settingsController.showSettings);
router.get('/settings/traffic-script', adminAuth, exportLimiter, settingsController.downloadTrafficScript);
router.post('/settings/test-webhook', adminAuth, settingsController.testWebhook);
router.post('/settings', adminAuth, verifyCsrf, (req, res, next) => {
  upload.single('organization_logo')(req, res, err => {
    if (err instanceof multer.MulterError || err) {
      // Propaga o erro de upload para o controller que já tem o helper renderSettings completo
      req.uploadError = err.message || 'Erro ao processar o arquivo enviado.';
    }
    next();
  });
}, settingsController.saveSettings);

module.exports = router;
module.exports.invalidateSecurityCount = securityCountCache.invalidate;
