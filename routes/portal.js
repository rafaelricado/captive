const express = require('express');
const router = express.Router();
const portalController = require('../controllers/portalController');

router.get('/', portalController.showPortal);
router.get('/success', portalController.showSuccess);

module.exports = router;
