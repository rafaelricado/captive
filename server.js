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
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const cron = require('node-cron');
const { initDatabase } = require('./models');
const { expireSessions } = require('./services/sessionService');

const portalRoutes = require('./routes/portal');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Confia em um nível de proxy reverso (nginx) para X-Forwarded-For e X-Forwarded-Proto
// Necessário para rate limiting correto e flag Secure no cookie quando atrás do nginx
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Cabeçalhos de segurança HTTP
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessão com store persistente no PostgreSQL (sobrevive a reinicializações)
const sessionStore = new pgSession({
  conString: `postgresql://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASS)}@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME}`,
  tableName: 'admin_sessions',
  createTableIfMissing: true
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.HTTPS_ENABLED === 'true', // ativar quando nginx+SSL estiver ativo
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

// Conexão ao banco com retry (até 5 tentativas com intervalo de 3s)
async function connectDatabase(maxAttempts = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initDatabase();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.warn(`[Servidor] Tentativa ${attempt}/${maxAttempts} de conexão falhou: ${err.message}`);
      console.warn(`[Servidor] Reconectando em ${delayMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// Inicialização
async function start() {
  try {
    await connectDatabase();

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
    });
  } catch (err) {
    console.error('[Servidor] Erro ao iniciar:', err.message);
    process.exit(1);
  }
}

start();
