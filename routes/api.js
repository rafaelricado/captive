const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const apiController = require('../controllers/apiController');
const { getOrgSettings } = require('../utils/orgSettings');

// Limita cadastro e login: máximo 10 tentativas a cada 15 minutos por IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: async (req, res) => {
    const { mac, ip, linkOrig } = req.body;
    try {
      const org = await getOrgSettings();
      res.status(429).render('portal', {
        mac: mac || '',
        ip: ip || '',
        username: '',
        linkOrig: linkOrig || '',
        error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.',
        activeTab: req.path === '/login' ? 'login' : 'cadastro',
        ...org
      });
    } catch (_) {
      res.status(429).send('Muitas tentativas. Aguarde 15 minutos e tente novamente.');
    }
  }
});

// Limita consulta de CEP: 60 requisições a cada 10 minutos por IP
const cepLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas consultas. Aguarde alguns minutos.' }
});

router.post('/register', authLimiter, apiController.register);
router.post('/login', authLimiter, apiController.login);
router.get('/cep/:cep', cepLimiter, apiController.consultaCep);

module.exports = router;
