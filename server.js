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
const logger = require('./utils/logger');
const { initDatabase, sequelize } = require('./models');
const { expireSessions } = require('./services/sessionService');
const { pingAllAccessPoints } = require('./services/pingService');

const portalRoutes = require('./routes/portal');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Confia em um nível de proxy reverso (nginx) para X-Forwarded-For e X-Forwarded-Proto
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// ─── Cabeçalhos de segurança HTTP ────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Content Security Policy
  // unsafe-inline necessário para estilos dinâmicos (cores do portal)
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );

  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessão com store persistente no PostgreSQL
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
    secure: process.env.HTTPS_ENABLED === 'true',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000 // 8 horas
  }
}));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await sequelize.authenticate();
    res.json({
      status: 'ok',
      db: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      db: 'unreachable',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  }
});

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
      logger.warn(`[Servidor] Tentativa ${attempt}/${maxAttempts} de conexão falhou: ${err.message}`);
      logger.warn(`[Servidor] Reconectando em ${delayMs / 1000}s...`);
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
        logger.info('[Cron] Verificando sessões expiradas...');
        await expireSessions();
      } catch (err) {
        logger.error(`[Cron] Erro ao expirar sessões: ${err.message}`);
      }
    });

    // Cron: pingar pontos de acesso a cada 5 minutos
    cron.schedule('*/5 * * * *', async () => {
      try {
        const { AccessPoint } = require('./models');
        const count = await AccessPoint.count({ where: { active: true } });
        if (count === 0) return;
        await pingAllAccessPoints();
      } catch (err) {
        logger.error(`[Cron] Erro ao verificar pontos de acesso: ${err.message}`);
      }
    });

    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`[Servidor] Captive Portal rodando em http://0.0.0.0:${PORT}`);
    });

    // ─── Graceful Shutdown ────────────────────────────────────────────────────
    async function shutdown(signal) {
      logger.info(`[Servidor] ${signal} recebido — encerrando...`);
      server.close(async () => {
        try {
          await sequelize.close();
          logger.info('[Servidor] Conexão com banco encerrada. Saindo.');
        } catch (err) {
          logger.error(`[Servidor] Erro ao fechar banco: ${err.message}`);
        }
        process.exit(0);
      });

      // Força saída após 10s se não conseguir fechar limpo
      setTimeout(() => {
        logger.error('[Servidor] Encerramento forçado após timeout.');
        process.exit(1);
      }, 10000);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    logger.error(`[Servidor] Erro ao iniciar: ${err.message}`);
    process.exit(1);
  }
}

start();
