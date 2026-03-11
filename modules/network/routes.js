const express = require('express');
const router  = express.Router();
const rateLimit = require('express-rate-limit');
const adminAuth = require('../../middleware/adminAuth');
const { verifyCsrf } = require('../../middleware/csrfProtection');

const accessPointsController = require('./controllers/accessPointsController');
const networkController      = require('./controllers/networkController');
const devicesController      = require('./controllers/devicesController');
const managedIpsController   = require('./controllers/managedIpsController');

// Rate limit: exportações — máximo 20 req/minuto por IP
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

// Pontos de acesso
// IMPORTANTE: rota /ping deve vir antes de /:id/* para não ser capturada pelo param
router.get('/access-points',              adminAuth, accessPointsController.accessPoints);
router.post('/access-points/ping',        adminAuth, verifyCsrf, accessPointsController.pingAccessPoints);
router.get('/access-points/:id/history',  adminAuth, accessPointsController.apHistory);
router.post('/access-points',             adminAuth, verifyCsrf, accessPointsController.saveAccessPoint);
router.post('/access-points/:id/delete',  adminAuth, verifyCsrf, accessPointsController.deleteAccessPoint);

// Rede / Tráfego
router.get('/traffic',        adminAuth, networkController.traffic);
router.get('/traffic/export', adminAuth, exportLimiter, networkController.exportTraffic);
router.get('/traffic/data',   adminAuth, networkController.trafficData);
router.get('/wan',            adminAuth, networkController.wan);
router.get('/wan/data',       adminAuth, networkController.wanData);
router.get('/connections',    adminAuth, networkController.connections);
router.get('/connections/data', adminAuth, networkController.connectionsData);
router.get('/dns',            adminAuth, networkController.dns);

// Histórico de dispositivos
// IMPORTANTE: rota estática '/devices' deve vir antes de '/devices/:mac'
router.get('/devices',        adminAuth, devicesController.devices);
router.get('/devices/export', adminAuth, exportLimiter, devicesController.exportDevices);
router.get('/devices/:mac',   adminAuth, devicesController.deviceDetail);

// IPs Gerenciados
// IMPORTANTE: rotas estáticas devem vir antes de /:id/*
router.get('/managed-ips',               adminAuth, managedIpsController.managedIps);
router.post('/managed-ips',              adminAuth, verifyCsrf, managedIpsController.saveManagedIp);
router.get('/managed-ips/arp-table',     adminAuth, managedIpsController.arpTable);
router.get('/managed-ips/:id',           adminAuth, managedIpsController.managedIpDetail);
router.post('/managed-ips/:id',          adminAuth, verifyCsrf, managedIpsController.saveManagedIp);
router.post('/managed-ips/:id/delete',   adminAuth, verifyCsrf, managedIpsController.deleteManagedIp);
router.get('/managed-ips/:id/live',      adminAuth, managedIpsController.managedIpLive);
router.post('/managed-ips/:id/sync',     adminAuth, verifyCsrf, managedIpsController.syncManagedIp);
router.post('/managed-ips/:id/identify', adminAuth, verifyCsrf, managedIpsController.identifyManagedIp);

module.exports = router;
