const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const adminController = require('../controllers/adminController');

// Login (público)
router.get('/login', adminController.showLogin);
router.post('/login', adminController.login);
router.post('/logout', adminController.logout);

// Painel (protegido)
router.get('/', adminAuth, adminController.dashboard);
router.get('/users', adminAuth, adminController.users);
router.get('/sessions', adminAuth, adminController.sessions);

module.exports = router;
