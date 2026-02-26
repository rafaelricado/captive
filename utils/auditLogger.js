const fs = require('fs');
const path = require('path');
const winston = require('winston');

// Garante que o diretório de logs existe (cria logger antes de qualquer requisição)
const logsDir = path.join(__dirname, '../logs');
fs.mkdirSync(logsDir, { recursive: true });

const auditWinston = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'audit.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 30,
      tailable: true
    })
  ]
});

/**
 * Registra uma ação administrativa no log de auditoria.
 * @param {string} action   - Identificador da ação (ex: 'user.delete', 'settings.update')
 * @param {object} details  - Dados adicionais (id, ip, campos alterados, etc.)
 */
function audit(action, details = {}) {
  auditWinston.info({ action, ...details });
}

module.exports = { audit };
