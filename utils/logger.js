const fs = require('fs');
const path = require('path');
const winston = require('winston');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Garante que o diretório de logs existe
const logsDir = path.join(__dirname, '../logs');
fs.mkdirSync(logsDir, { recursive: true });

// Formato legível para console
const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ timestamp, level, message, stack }) =>
    stack ? `${timestamp} [${level}] ${message}\n${stack}` : `${timestamp} [${level}] ${message}`
  )
);

// Formato JSON para arquivos (facilita parsing por ferramentas externas)
const fileFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  json()
);

const transports = [
  new winston.transports.Console({ format: consoleFormat }),
  // app.log: todos os níveis, rotação por tamanho (10 MB, 14 arquivos)
  new winston.transports.File({
    filename: path.join(logsDir, 'app.log'),
    format: fileFormat,
    maxsize: 10 * 1024 * 1024,
    maxFiles: 14,
    tailable: true
  }),
  // error.log: apenas erros
  new winston.transports.File({
    filename: path.join(logsDir, 'error.log'),
    level: 'error',
    format: fileFormat,
    maxsize: 10 * 1024 * 1024,
    maxFiles: 14,
    tailable: true
  })
];

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports
});

module.exports = logger;
