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
const securityController     = require('../controllers/admin/securityController');
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
router.get('/',        adminAuth, dashboardController.home);
router.get('/captive', adminAuth, dashboardController.dashboard);
router.get('/users', adminAuth, usersController.users);
router.get('/users/export', adminAuth, exportLimiter, usersController.exportUsers);
router.post('/users/:id/delete', adminAuth, verifyCsrf, usersController.deleteUser);
router.get('/sessions', adminAuth, sessionsController.sessions);
router.get('/sessions/export', adminAuth, exportLimiter, sessionsController.exportSessions);
router.post('/sessions/:id/terminate', adminAuth, verifyCsrf, sessionsController.terminateSession);

// Segurança — Eventos detectados (protegido)
// IMPORTANTE: rotas estáticas devem vir antes de /:id/*
router.get('/security', adminAuth, securityController.security);
router.get('/security/data', adminAuth, securityController.securityData);
router.get('/security/export', adminAuth, exportLimiter, securityController.securityExport);
router.post('/security/acknowledge-all', adminAuth, verifyCsrf, securityController.acknowledgeAllSecurityEvents);
router.post('/security/:id/acknowledge', adminAuth, verifyCsrf, securityController.acknowledgeSecurityEvent);

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
