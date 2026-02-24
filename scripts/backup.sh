#!/bin/bash
# =============================================================================
# backup.sh — Backup do banco de dados PostgreSQL do Captive Portal
# =============================================================================
# Uso:
#   chmod +x backup.sh
#   sudo -u postgres bash backup.sh
#   # ou como root:
#   sudo bash backup.sh
#
# Agendamento via cron (executar como root):
#   crontab -e
#   # Backup diário às 2h da manhã:
#   0 2 * * * /opt/captive/scripts/backup.sh >> /var/log/captive-backup.log 2>&1
#
# Variáveis de ambiente (.env do projeto):
#   DB_NAME, DB_USER, DB_HOST, DB_PORT
#   Se não definidas, usa os valores padrão abaixo.
# =============================================================================

set -euo pipefail

# ─── Configurações ────────────────────────────────────────────────────────────

# Diretório de destino dos backups
BACKUP_DIR="${BACKUP_DIR:-/opt/captive/backups}"

# Parâmetros do banco (lê do .env se existir)
ENV_FILE="${ENV_FILE:-/opt/captive/.env}"
if [[ -f "$ENV_FILE" ]]; then
  # Exporta apenas variáveis de banco; ignora linhas com # e linhas vazias
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    key=$(echo "$key" | tr -d '[:space:]')
    value=$(echo "$value" | sed 's/^"//;s/"$//')   # remove aspas duplas
    case "$key" in
      DB_NAME|DB_USER|DB_HOST|DB_PORT) export "$key=$value" ;;
    esac
  done < "$ENV_FILE"
fi

DB_NAME="${DB_NAME:-captive_portal}"
DB_USER="${DB_USER:-captive_user}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

# Quantos dias manter
KEEP_DAYS="${KEEP_DAYS:-7}"

# ─── Preparação ──────────────────────────────────────────────────────────────

mkdir -p "$BACKUP_DIR"
chmod 750 "$BACKUP_DIR"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
FILE="${BACKUP_DIR}/captive_${TIMESTAMP}.sql.gz"

# ─── Dump ────────────────────────────────────────────────────────────────────

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando backup: ${DB_NAME}@${DB_HOST}:${DB_PORT}"

PGPASSWORD="" pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --no-password \
  | gzip > "$FILE"

SIZE=$(du -sh "$FILE" | cut -f1)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup salvo: ${FILE} (${SIZE})"

# ─── Rotação ─────────────────────────────────────────────────────────────────

DELETED=$(find "$BACKUP_DIR" -name "captive_*.sql.gz" -mtime +"$KEEP_DAYS" -print -delete | wc -l)
if [[ "$DELETED" -gt 0 ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Removidos ${DELETED} backup(s) com mais de ${KEEP_DAYS} dias."
fi

# ─── Resumo ──────────────────────────────────────────────────────────────────

TOTAL=$(find "$BACKUP_DIR" -name "captive_*.sql.gz" | wc -l)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup concluído. ${TOTAL} arquivo(s) em ${BACKUP_DIR}."

# ─── Restauração (instruções) ─────────────────────────────────────────────────
#
# Para restaurar um backup:
#   gunzip -c /opt/captive/backups/captive_YYYYMMDD_HHMMSS.sql.gz \
#     | psql -h localhost -U captive_user -d captive_portal
#
# ATENÇÃO: a restauração SUBSTITUI os dados existentes no banco.
