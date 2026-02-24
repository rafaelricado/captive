const winston = require('winston');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Formato legível para console
const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ timestamp, level, message, stack }) =>
    stack ? `${timestamp} [${level}] ${message}\n${stack}` : `${timestamp} [${level}] ${message}`
  )
);

const transports = [
  new winston.transports.Console({ format: consoleFormat })
];

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports
});

module.exports = logger;
