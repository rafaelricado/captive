require('dotenv').config();

// Validação de variáveis de ambiente obrigatórias
const requiredEnvVars = [
  'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS',
  'MIKROTIK_HOST', 'MIKROTIK_USER', 'MIKROTIK_PASS',
  'ADMIN_USER', 'ADMIN_PASSWORD', 'SESSION_SECRET'
];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`[Servidor] Variáveis de ambiente faltando: ${missing.join(', ')}`);
  console.error('[Servidor] Copie .env.example para .env e preencha os valores.');
  process.exit(1);
}

const express = require('express');
const session = require('express-session');
const path = require('path');
const cron = require('node-cron');
const { initDatabase } = require('./models');
const { expireSessions } = require('./services/sessionService');

const portalRoutes = require('./routes/portal');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessão (usada pelo painel admin)
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',          // Proteção CSRF: bloqueia envio cross-origin
    maxAge: 8 * 60 * 60 * 1000 // 8 horas
  }
}));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Rotas
app.use('/', portalRoutes);
app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);

// Inicialização
async function start() {
  try {
    await initDatabase();

    // Cron: verificar sessões expiradas a cada 30 minutos
    cron.schedule('*/30 * * * *', async () => {
      try {
        console.log('[Cron] Verificando sessões expiradas...');
        await expireSessions();
      } catch (err) {
        console.error('[Cron] Erro ao expirar sessões:', err.message);
      }
    });

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Servidor] Captive Portal rodando em http://0.0.0.0:${PORT}`);
      console.log('[Servidor] Hospital Beneficiente Portuguesa - BP TI');
    });
  } catch (err) {
    console.error('[Servidor] Erro ao iniciar:', err.message);
    process.exit(1);
  }
}

start();
