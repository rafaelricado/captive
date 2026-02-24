#!/bin/bash
# ===========================================
# Script de Instalacao - Captive Portal
# Ubuntu Server
# ===========================================

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo ""
echo "============================================"
echo "  Captive Portal"
echo "  Script de Instalacao - Ubuntu"
echo "============================================"
echo ""

# -----------------------------------------------
# Verificacoes iniciais
# -----------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  echo -e "${RED}Nao execute como root. Use um usuario normal com sudo.${NC}"
  exit 1
fi

if ! sudo -v 2>/dev/null; then
  echo -e "${RED}Usuario precisa ter permissao sudo.${NC}"
  exit 1
fi

# -----------------------------------------------
# [1/7] Atualizar sistema e instalar dependencias base
# -----------------------------------------------
echo -e "${YELLOW}[1/7] Atualizando sistema e instalando dependencias base...${NC}"
sudo apt update
sudo apt install -y curl wget gnupg2 ca-certificates lsb-release

# -----------------------------------------------
# [2/7] Instalar Node.js 20 LTS
# -----------------------------------------------
echo -e "${YELLOW}[2/7] Instalando Node.js 20 LTS...${NC}"
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
elif [[ "$(node -v)" != v20* ]] && [[ "$(node -v)" != v22* ]]; then
  echo -e "${YELLOW}Node.js $(node -v) encontrado, atualizando para v20...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

NODE_BIN=$(which node)
echo -e "${GREEN}Node.js $(node -v) instalado em ${NODE_BIN}${NC}"

# -----------------------------------------------
# [3/7] Instalar e configurar PostgreSQL
# -----------------------------------------------
echo -e "${YELLOW}[3/7] Instalando PostgreSQL...${NC}"
sudo apt install -y postgresql postgresql-contrib

sudo systemctl enable postgresql
sudo systemctl start postgresql

echo "Aguardando PostgreSQL ficar pronto..."
RETRIES=0
while ! pg_isready -h localhost -q 2>/dev/null; do
  RETRIES=$((RETRIES + 1))
  if [ "$RETRIES" -ge 20 ]; then
    echo -e "${RED}PostgreSQL nao iniciou apos 20 segundos.${NC}"
    echo "Verifique com: sudo systemctl status postgresql"
    exit 1
  fi
  sleep 1
done
echo -e "${GREEN}PostgreSQL pronto.${NC}"

echo ""
echo "--- Configuracao do Banco de Dados ---"
read -s -p "Defina a senha para o usuario 'captive_user' no PostgreSQL: " DB_PASS
echo ""

if [ -z "$DB_PASS" ]; then
  echo -e "${RED}Senha nao pode ser vazia.${NC}"
  exit 1
fi

# Criar usuario (forma segura - sem interpolacao de variavel no SQL)
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='captive_user'" | grep -q 1; then
  echo "Usuario 'captive_user' ja existe, atualizando senha..."
  sudo -u postgres psql -c "ALTER USER captive_user WITH PASSWORD '$(echo "$DB_PASS" | sed "s/'/''/g")';"
else
  sudo -u postgres psql -c "CREATE USER captive_user WITH PASSWORD '$(echo "$DB_PASS" | sed "s/'/''/g")';"
fi

# Criar banco
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='captive_portal'" | grep -q 1; then
  echo "Banco 'captive_portal' ja existe."
else
  sudo -u postgres createdb -O captive_user captive_portal
fi

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE captive_portal TO captive_user;" 2>/dev/null

echo -e "${GREEN}Banco de dados configurado.${NC}"

# -----------------------------------------------
# [4/7] Instalar dependencias npm
# -----------------------------------------------
echo -e "${YELLOW}[4/7] Instalando dependencias npm...${NC}"
cd "$PROJECT_DIR"
npm install --production

# -----------------------------------------------
# [5/7] Configurar .env
# -----------------------------------------------
echo -e "${YELLOW}[5/7] Configurando variaveis de ambiente...${NC}"

if [ -f .env ]; then
  echo -e "${YELLOW}.env ja existe. Deseja sobrescrever? (s/N)${NC}"
  read -r OVERWRITE
  if [[ "$OVERWRITE" != "s" && "$OVERWRITE" != "S" ]]; then
    echo "Mantendo .env existente."
  else
    rm -f .env
  fi
fi

if [ ! -f .env ]; then
  echo ""
  echo "--- Configuracao do Mikrotik ---"
  read -p "IP do Mikrotik [192.168.1.1]: " MK_HOST
  MK_HOST=${MK_HOST:-192.168.1.1}

  read -p "Usuario do Mikrotik para API [captive_api]: " MK_USER
  MK_USER=${MK_USER:-captive_api}

  read -s -p "Senha do usuario Mikrotik API: " MK_PASS
  echo ""

  if [ -z "$MK_PASS" ]; then
    echo -e "${RED}Senha do Mikrotik nao pode ser vazia.${NC}"
    exit 1
  fi

  read -p "Porta da API do Mikrotik [8728]: " MK_PORT
  MK_PORT=${MK_PORT:-8728}

  read -p "Duracao da sessao em horas [48]: " SESSION_HOURS
  SESSION_HOURS=${SESSION_HOURS:-48}

  read -p "Usuario do painel admin [admin]: " ADMIN_USER
  ADMIN_USER=${ADMIN_USER:-admin}

  read -s -p "Senha do painel admin: " ADMIN_PASSWORD
  echo ""
  if [ -z "$ADMIN_PASSWORD" ]; then
    echo -e "${RED}Senha do admin nao pode ser vazia.${NC}"
    exit 1
  fi

  # Gerar SESSION_SECRET aleatorio
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

  cat > .env <<ENVFILE
# Servidor
PORT=3000

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=captive_portal
DB_USER=captive_user
DB_PASS=${DB_PASS}

# Mikrotik RouterOS API
MIKROTIK_HOST=${MK_HOST}
MIKROTIK_USER=${MK_USER}
MIKROTIK_PASS=${MK_PASS}
MIKROTIK_PORT=${MK_PORT}

# Sessao (em horas)
SESSION_DURATION_HOURS=${SESSION_HOURS}

# Painel Admin
ADMIN_USER=${ADMIN_USER}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
ENVFILE

  chmod 600 .env
  echo -e "${GREEN}.env criado com permissao restrita (600).${NC}"
fi

# -----------------------------------------------
# [6/7] Configurar servico systemd
# -----------------------------------------------
echo -e "${YELLOW}[6/7] Configurando servico systemd...${NC}"

sudo tee /etc/systemd/system/captive-portal.service > /dev/null <<EOF
[Unit]
Description=Captive Portal
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$(whoami)
Group=$(id -gn)
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable captive-portal

# -----------------------------------------------
# [7/7] Firewall e iniciar servico
# -----------------------------------------------
echo -e "${YELLOW}[7/7] Configurando firewall e iniciando servico...${NC}"

if command -v ufw &> /dev/null; then
  if sudo ufw status | grep -q "Status: active"; then
    sudo ufw allow 3000/tcp comment "Captive Portal" 2>/dev/null || true
    echo -e "${GREEN}Porta 3000 liberada no UFW.${NC}"
  fi
fi

sudo systemctl start captive-portal

# Verificar se iniciou
sleep 5
if sudo systemctl is-active --quiet captive-portal; then
  echo -e "${GREEN}Servico iniciado com sucesso.${NC}"
else
  echo -e "${RED}Servico nao iniciou. Verifique os logs:${NC}"
  echo "  sudo journalctl -u captive-portal -n 30"
  exit 1
fi

# -----------------------------------------------
# Resumo final
# -----------------------------------------------
SERVER_IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  INSTALACAO CONCLUIDA!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Captive Portal rodando em: http://${SERVER_IP}:3000"
echo ""
echo "Comandos uteis:"
echo "  sudo systemctl status captive-portal    # Ver status"
echo "  sudo systemctl restart captive-portal   # Reiniciar"
echo "  sudo journalctl -u captive-portal -f    # Ver logs"
echo ""
echo "============================================"
echo "  PROXIMO PASSO: CONFIGURAR O MIKROTIK"
echo "============================================"
echo ""
echo "Importe o script de configuracao no Mikrotik:"
echo ""
echo "  1. Copie o arquivo scripts/mikrotik_setup.rsc para o Mikrotik"
echo "     via Winbox (Files) ou SCP/FTP"
echo ""
echo "  2. Edite as variaveis no INICIO do arquivo .rsc:"
echo "     - portalServerIP  = ${SERVER_IP}"
echo "     - wanInterface    = ether1 (ou sua interface WAN)"
echo "     - lanInterface    = ether2 (ou sua interface LAN)"
echo "     - wifiInterface   = wlan1  (ou sua interface wireless)"
echo "     - apiPassword     = senha do usuario API"
echo ""
echo "  3. No terminal do Mikrotik, execute:"
echo "     /import file-name=mikrotik_setup.rsc"
echo ""
echo "  OU configure manualmente seguindo o README.md"
echo ""
