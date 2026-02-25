const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const mikrotikDataController = require('../controllers/mikrotikDataController');

// Rate limit: Mikrotik envia a cada 5 min, este limite aceita até 60 req/5min por IP
const mikrotikLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

router.post('/traffic', mikrotikLimiter, mikrotikDataController.receiveTraffic);
router.post('/details', mikrotikLimiter, mikrotikDataController.receiveDetails);

module.exports = router;
