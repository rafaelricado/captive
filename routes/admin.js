const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const adminAuth = require('../middleware/adminAuth');
const adminController = require('../controllers/adminController');
const { Setting } = require('../models');

// Garante que o diretório de upload existe
const uploadsDir = path.join(__dirname, '../public/uploads/logo');
fs.mkdirSync(uploadsDir, { recursive: true });

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

// Middleware: injeta configurações de marca em res.locals para todas as rotas admin
router.use(async (req, res, next) => {
  try {
    res.locals.orgName = await Setting.get('organization_name', 'Captive Portal');
    res.locals.orgLogo = await Setting.get('organization_logo', '');
  } catch (_) {
    res.locals.orgName = 'Captive Portal';
    res.locals.orgLogo = '';
  }
  next();
});

// Login (público)
router.get('/login', adminController.showLogin);
router.post('/login', adminLoginLimiter, adminController.login);
router.post('/logout', adminController.logout);

// Painel (protegido)
router.get('/', adminAuth, adminController.dashboard);
router.get('/users', adminAuth, adminController.users);
router.get('/users/export', adminAuth, adminController.exportUsers);
router.post('/users/:id/delete', adminAuth, adminController.deleteUser);
router.get('/sessions', adminAuth, adminController.sessions);
router.post('/sessions/:id/terminate', adminAuth, adminController.terminateSession);

// Pontos de acesso (protegido)
// IMPORTANTE: rota /ping deve vir antes de /:id/* para não ser capturada pelo param
router.get('/access-points', adminAuth, adminController.accessPoints);
router.post('/access-points/ping', adminAuth, adminController.pingAccessPoints);
router.get('/access-points/:id/history', adminAuth, adminController.apHistory);
router.post('/access-points', adminAuth, adminController.saveAccessPoint);
router.post('/access-points/:id/delete', adminAuth, adminController.deleteAccessPoint);

// Rede / Tráfego Mikrotik (protegido)
router.get('/traffic', adminAuth, adminController.traffic);
router.get('/wan', adminAuth, adminController.wan);
router.get('/connections', adminAuth, adminController.connections);
router.get('/dns', adminAuth, adminController.dns);

// Endpoints JSON para auto-refresh das páginas (protegido)
router.get('/traffic/data', adminAuth, adminController.trafficData);
router.get('/wan/data', adminAuth, adminController.wanData);
router.get('/connections/data', adminAuth, adminController.connectionsData);

// Configurações (protegido)
router.get('/settings', adminAuth, adminController.showSettings);
router.post('/settings', adminAuth, (req, res, next) => {
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
