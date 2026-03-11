const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const adminAuth = require('../../middleware/adminAuth');
const { csrfMiddleware, verifyCsrf } = require('../../middleware/csrfProtection');

const tasyController          = require('./controllers/tasyController');
const tasyProtocoloController = require('./controllers/tasyProtocoloController');
const tasyAlertaController    = require('./controllers/tasyAlertaController');
const tasyOcupacaoController  = require('./controllers/tasyOcupacaoController');
const tasyAgendaController    = require('./controllers/tasyAgendaController');

// Rate limit compartilhado para exportações do módulo hospital
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

// Tasy — Contas de paciente
router.get('/tasy',             adminAuth, tasyController.dashboard);
router.get('/tasy/data',        adminAuth, tasyController.data);
router.get('/tasy/export',      adminAuth, exportLimiter, tasyController.export);
router.post('/tasy/sync',       adminAuth, verifyCsrf, tasyController.sync);
router.get('/tasy/sync/stream', adminAuth, tasyController.syncStream);

// Protocolo convênio
router.get ('/tasy/protocolos',             adminAuth, csrfMiddleware, tasyProtocoloController.list);
router.post('/tasy/protocolos/sync',        adminAuth, verifyCsrf,     tasyProtocoloController.sync);
router.get ('/tasy/protocolos/sync/stream', adminAuth,                 tasyProtocoloController.syncStream);
router.get ('/tasy/protocolos/export',      adminAuth, exportLimiter,  tasyProtocoloController.export);

// Resumos
router.get('/tasy/resumo',                adminAuth, csrfMiddleware, tasyProtocoloController.resumo);
router.get('/tasy/resumo/export',         adminAuth, exportLimiter,  tasyProtocoloController.resumoExport);
router.get('/tasy/resumo/contas',         adminAuth, csrfMiddleware, tasyProtocoloController.resumoContas);
router.get('/tasy/resumo/contas/export',  adminAuth, exportLimiter,  tasyProtocoloController.resumoContasExport);
router.get('/tasy/resumo/protocolos',     adminAuth, csrfMiddleware, tasyProtocoloController.resumoProtocolos);

// Alertas, Ocupação e Agenda
router.get('/tasy/alertas',   adminAuth, csrfMiddleware, tasyAlertaController.alertas);
router.get('/tasy/ocupacao',  adminAuth, csrfMiddleware, tasyOcupacaoController.ocupacao);
router.get('/tasy/agenda',    adminAuth, csrfMiddleware, tasyAgendaController.agenda);

module.exports = router;
