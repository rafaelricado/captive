#!/bin/bash
# =============================================================================
# setup_nginx.sh — Configura nginx como reverse proxy HTTPS para o Captive Portal
# =============================================================================
# Uso:
#   chmod +x setup_nginx.sh
#   sudo ./setup_nginx.sh
#
# O script instala nginx e configura SSL, com duas opções:
#   1. Certificado Let's Encrypt (domínio público com DNS)
#   2. Certificado auto-assinado (IP interno ou domínio sem DNS público)
#
# Após a configuração:
#   - Porta 80 → redirect para HTTPS
#   - Porta 443 → proxy para http://127.0.0.1:3000 (Node.js)
#   - Acesso Mikrotik: continua em http://<IP>:3000 (captive portal detection)
# =============================================================================

set -e

# ─── Verificações ─────────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  echo "Execute como root: sudo $0"
  exit 1
fi

if ! command -v apt-get &>/dev/null; then
  echo "Este script requer um sistema baseado em Debian/Ubuntu."
  exit 1
fi

# ─── Instalação de dependências ───────────────────────────────────────────────

echo ""
echo "==> Instalando nginx..."
apt-get update -qq
apt-get install -y nginx

# ─── Escolha do tipo de certificado ──────────────────────────────────────────

echo ""
echo "Tipo de certificado SSL:"
echo "  1) Let's Encrypt (domínio público com DNS apontando para este servidor)"
echo "  2) Auto-assinado  (IP interno, sem DNS público)"
echo ""
read -rp "Escolha [1/2]: " CERT_TYPE

# ─── Let's Encrypt ────────────────────────────────────────────────────────────

if [[ "$CERT_TYPE" == "1" ]]; then
  read -rp "Domínio (ex: portal.empresa.com.br): " DOMAIN
  if [[ -z "$DOMAIN" ]]; then
    echo "Domínio não informado. Abortando."
    exit 1
  fi

  read -rp "E-mail para notificações Let's Encrypt: " LE_EMAIL
  if [[ -z "$LE_EMAIL" ]]; then
    echo "E-mail não informado. Abortando."
    exit 1
  fi

  echo ""
  echo "==> Instalando certbot..."
  apt-get install -y certbot python3-certbot-nginx

  # Config nginx temporária para validação HTTP-01
  cat > /etc/nginx/sites-available/captive <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto http;
    }
}
NGINX

  ln -sf /etc/nginx/sites-available/captive /etc/nginx/sites-enabled/captive
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx

  echo ""
  echo "==> Obtendo certificado Let's Encrypt para ${DOMAIN}..."
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$LE_EMAIL" --redirect

  CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  KEY_PATH="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
  SERVER_NAME="$DOMAIN"

# ─── Auto-assinado ────────────────────────────────────────────────────────────

elif [[ "$CERT_TYPE" == "2" ]]; then
  read -rp "IP ou domínio do servidor (ex: 10.0.0.56): " SERVER_IP
  if [[ -z "$SERVER_IP" ]]; then
    echo "IP/domínio não informado. Abortando."
    exit 1
  fi

  SSL_DIR="/etc/ssl/captive"
  mkdir -p "$SSL_DIR"
  CERT_PATH="${SSL_DIR}/cert.pem"
  KEY_PATH="${SSL_DIR}/key.pem"
  SERVER_NAME="$SERVER_IP"

  echo ""
  echo "==> Gerando certificado auto-assinado para ${SERVER_IP}..."
  openssl req -x509 -nodes -days 3650 \
    -newkey rsa:2048 \
    -keyout "$KEY_PATH" \
    -out "$CERT_PATH" \
    -subj "/CN=${SERVER_IP}/O=Captive Portal/C=BR" \
    -addext "subjectAltName=IP:${SERVER_IP},DNS:${SERVER_IP}" 2>/dev/null || \
  openssl req -x509 -nodes -days 3650 \
    -newkey rsa:2048 \
    -keyout "$KEY_PATH" \
    -out "$CERT_PATH" \
    -subj "/CN=${SERVER_IP}/O=Captive Portal/C=BR"

  chmod 600 "$KEY_PATH"
  echo "Certificado salvo em ${CERT_PATH}"

else
  echo "Opção inválida. Abortando."
  exit 1
fi

# ─── Configuração nginx final ─────────────────────────────────────────────────

echo ""
echo "==> Configurando nginx..."

cat > /etc/nginx/sites-available/captive <<NGINX
# Captive Portal — configuração nginx
# Gerado por setup_nginx.sh em $(date '+%Y-%m-%d %H:%M:%S')

# Redirect HTTP → HTTPS
server {
    listen 80;
    server_name ${SERVER_NAME};
    return 301 https://\$host\$request_uri;
}

# HTTPS → Node.js
server {
    listen 443 ssl;
    server_name ${SERVER_NAME};

    ssl_certificate     ${CERT_PATH};
    ssl_certificate_key ${KEY_PATH};

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Logs
    access_log /var/log/nginx/captive_access.log;
    error_log  /var/log/nginx/captive_error.log;

    # Proxy para Node.js
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_read_timeout 30s;
        proxy_connect_timeout 10s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/captive /etc/nginx/sites-enabled/captive
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx

# ─── Firewall (UFW) ──────────────────────────────────────────────────────────

if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  echo ""
  echo "==> Abrindo portas 80 e 443 no UFW..."
  ufw allow 80/tcp
  ufw allow 443/tcp
fi

# ─── Conclusão ────────────────────────────────────────────────────────────────

echo ""
echo "================================================================"
echo " nginx configurado com sucesso!"
echo ""
if [[ "$CERT_TYPE" == "1" ]]; then
  echo " Painel admin: https://${SERVER_NAME}/admin"
  echo " Renovação automática: systemctl list-timers certbot*"
else
  echo " Painel admin: https://${SERVER_NAME}/admin"
  echo " AVISO: Certificado auto-assinado — o navegador exibirá um aviso."
  echo "         Adicione o certificado à lista de confiança do navegador"
  echo "         ou da CA corporativa para remover o aviso."
fi
echo ""
echo " NOTA: O Mikrotik deve continuar redirecionando para:"
echo "       http://<IP_DO_SERVIDOR>:3000"
echo "       (captive portal detection em iOS/Android não usa HTTPS)"
echo "================================================================"
