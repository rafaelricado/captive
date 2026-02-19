const express = require('express');
const router = express.Router();
const apiController = require('../controllers/apiController');

router.post('/register', apiController.register);
router.post('/login', apiController.login);
router.get('/cep/:cep', apiController.consultaCep);

module.exports = router;
