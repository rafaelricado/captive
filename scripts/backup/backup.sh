#!/bin/bash
# =============================================================
# Backup do PostgreSQL - Captive Portal
# Configurar em crontab: 0 2 * * * /path/to/backup.sh
#
# Uso standalone (fora do Docker):
#   DB_HOST=localhost DB_PORT=5432 DB_NAME=captive \
#   DB_USER=captive DB_PASS=senha BACKUP_DIR=/backups ./backup.sh
#
# Uso com Docker Compose (roda dentro do container db):
#   docker compose exec db /backups/backup.sh
# =============================================================

set -euo pipefail

# ── Configuração (lê do ambiente ou .env se disponível) ──────
if [ -f "$(dirname "$0")/../../.env" ]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../../.env"
  set +o allexport
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:?DB_NAME nao configurado}"
DB_USER="${DB_USER:?DB_USER nao configurado}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$0")}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME="${BACKUP_DIR}/captive_${TIMESTAMP}.sql.gz"

# ── Executa pg_dump ──────────────────────────────────────────
echo "[backup] Iniciando backup: ${DB_NAME} -> ${FILENAME}"

PGPASSWORD="${DB_PASS:-}" pg_dump \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --username="${DB_USER}" \
  --no-password \
  --format=plain \
  --no-owner \
  --no-acl \
  "${DB_NAME}" | gzip > "${FILENAME}"

SIZE=$(du -sh "${FILENAME}" | cut -f1)
echo "[backup] OK: ${FILENAME} (${SIZE})"

# ── Remove backups antigos ────────────────────────────────────
find "${BACKUP_DIR}" -name "captive_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete
echo "[backup] Backups mais antigos que ${RETENTION_DAYS} dias removidos"
