# Captive Portal

Sistema de captive portal para autenticacao de visitantes na rede Wi-Fi, integrado com Mikrotik RouterOS v7.

---

## Indice

1. [Requisitos](#requisitos)
2. [Arquitetura](#arquitetura)
3. [Estrutura de Arquivos](#estrutura-de-arquivos)
4. [Instalacao Rapida (Script Automatico)](#instalacao-rapida)
5. [Instalacao Manual](#instalacao-manual)
6. [Variaveis de Ambiente](#variaveis-de-ambiente)
7. [Configuracao do Mikrotik](#configuracao-do-mikrotik)
8. [Fluxo de Funcionamento](#fluxo-de-funcionamento)
9. [Banco de Dados](#banco-de-dados)
10. [Rotas da API](#rotas-da-api)
11. [Painel Administrativo](#painel-administrativo)
12. [Ingestao de Dados Mikrotik](#ingestao-de-dados-mikrotik)
13. [Personalizacao de Marca e Cores](#personalizacao-de-marca-e-cores)
14. [Gerenciamento de Sessoes](#gerenciamento-de-sessoes)
15. [Seguranca](#seguranca)
16. [Comandos Uteis](#comandos-uteis)
17. [Troubleshooting](#troubleshooting)
18. [Dependencias do Projeto](#dependencias-do-projeto)

---

## Requisitos

### Servidor (Ubuntu)

| Componente   | Versao Minima | Recomendado  |
|-------------|--------------|-------------|
| Ubuntu      | 20.04 LTS    | 22.04 LTS   |
| Node.js     | 18.x         | 20.x LTS    |
| PostgreSQL  | 13           | 15+         |
| npm         | 9.x          | 10.x        |

### Rede

| Componente   | Requisito                            |
|-------------|--------------------------------------|
| Mikrotik    | RouterOS v7.x (testado em v7.19)     |
| API         | Porta 8728 habilitada no Mikrotik    |
| Rede        | Servidor acessivel pelo Mikrotik     |
| Internet    | Necessaria para consulta de CEP (ViaCEP) |

---

## Arquitetura

```
[Internet / Provedor]
         |
  [ ether5/ether6 ] WAN (dual)
         |
  [MIKROTIK CCR v7.19]
         |                          |
     [ ether2 ]               [ ether3/ether4 ]
  Rede visitantes              Rede interna hospital
  15.1.1.0/24                  10.0.0.0/22 / 192.168.0.0/24
  gateway 15.1.1.1                     |
         |                    [Ubuntu 10.0.0.56]
         |                    Captive Portal :3000
  [Visitante 15.1.1.x]        PostgreSQL :5432
  DHCP: 15.1.1.10-254                  |
         |                             |
  Mikrotik Hotspot intercepta          |
  redireciona HTTP -> 10.0.0.56:3000   |
         |                             |
         +-------- cadastro / login ---+
                                       |
                          Mikrotik API :8728 (ip-binding)
                                       |
                          ViaCEP API (autocompletar CEP)

  Visitantes isolados da rede interna via firewall
  Servidor bypassa o hotspot via ip-binding (libera por IP)
```

**Resumo do fluxo:**
1. Visitante conecta no Wi-Fi
2. Mikrotik Hotspot intercepta e redireciona para o captive portal
3. Visitante faz cadastro (primeiro acesso) ou login (por CPF)
4. Sistema salva dados no PostgreSQL
5. Sistema autoriza visitante no Mikrotik via API
6. Visitante navega normalmente
7. Apos 2 dias (configuravel), sessao expira e visitante deve reautenticar

---

## Estrutura de Arquivos

```
captive/
├── server.js                     # Ponto de entrada da aplicacao
├── package.json                  # Dependencias npm
├── .env.example                  # Modelo de variaveis de ambiente
├── .env                          # Variaveis de ambiente (criar a partir do .example)
│
├── config/
│   └── database.js               # Conexao com PostgreSQL via Sequelize
│
├── models/
│   ├── index.js                  # Inicializacao, sync do banco e associacoes
│   ├── User.js                   # Modelo de usuario (cadastro)
│   ├── Session.js                # Modelo de sessao (controle de acesso)
│   ├── Setting.js                # Configuracoes do sistema
│   ├── AccessPoint.js            # Modelo de ponto de acesso Wi-Fi
│   ├── ApPingHistory.js          # Historico de ping dos pontos de acesso
│   ├── TrafficRanking.js         # Ranking de trafego por cliente (Mikrotik)
│   ├── WanStat.js                # Estatisticas das interfaces WAN (Mikrotik)
│   ├── ClientConnection.js       # Snapshot de conexoes ativas (Mikrotik)
│   └── DnsEntry.js               # Cache DNS do roteador (Mikrotik)
│
├── middleware/
│   └── adminAuth.js              # Middleware de autenticacao do painel admin
│
├── controllers/
│   ├── portalController.js       # Renderizacao das paginas do portal
│   ├── apiController.js          # Logica de cadastro, login e CEP
│   ├── adminController.js        # Logica do painel administrativo
│   └── mikrotikDataController.js # Recepcao e persistencia dos dados enviados pelo Mikrotik
│
├── routes/
│   ├── portal.js                 # Rotas do portal (GET /, GET /success)
│   ├── api.js                    # Rotas da API (POST /api/register, etc.)
│   ├── admin.js                  # Rotas do painel admin (/admin/*)
│   └── mikrotik.js               # Rotas de ingestao de dados (/api/mikrotik/*)
│
├── services/
│   ├── mikrotikService.js        # Integracao com RouterOS API v7
│   ├── sessionService.js         # Criacao e expiracao de sessoes
│   └── pingService.js            # Monitoramento de APs via ping (ICMP)
│
├── utils/
│   ├── cpfValidator.js           # Validacao de CPF (algoritmo digitos verificadores)
│   ├── logger.js                 # Logger Winston estruturado (substitui console.*)
│   ├── orgSettings.js            # Helper compartilhado de configuracoes da organizacao
│   └── settingsCache.js          # Cache TTL em memoria (60s) para configuracoes
│
├── views/
│   ├── portal.ejs                # Pagina principal (cadastro + login)
│   ├── success.ejs               # Pagina de sucesso com expiracao dinamica da sessao
│   └── admin/
│       ├── login.ejs             # Tela de login do painel
│       ├── dashboard.ejs         # Dashboard com estatisticas e cards de status WAN
│       ├── users.ejs             # Lista de usuarios cadastrados
│       ├── sessions.ejs          # Lista de sessoes de acesso
│       ├── access-points.ejs     # Monitoramento de pontos de acesso Wi-Fi
│       ├── settings.ejs          # Pagina de configuracoes do portal
│       ├── traffic.ejs           # Ranking de trafego por cliente (atualiza a cada 30s)
│       ├── wan.ejs               # Estatisticas das interfaces WAN (atualiza a cada 30s)
│       ├── connections.ejs       # Conexoes ativas — snapshot do roteador (30s)
│       ├── dns.ejs               # Cache DNS do roteador (paginado, busca por dominio)
│       ├── _head.ejs             # Estilos compartilhados (partial)
│       ├── _nav.ejs              # Menu de navegacao (partial)
│       └── _footer.ejs           # Rodape (partial)
│
├── public/
│   ├── css/
│   │   └── style.css             # Estilos do portal (responsivo)
│   ├── js/
│   │   └── app.js                # JavaScript frontend (mascaras, validacao, CEP)
│   └── uploads/
│       └── logo/                 # Logos enviadas pelo admin (criado automaticamente)
│
└── scripts/
    ├── setup.sh                      # Script de instalacao automatica (Ubuntu)
    └── captive_portal_ether2.rsc     # Script de configuracao do Mikrotik (ether2, 15.1.1.0/24)
```

---

## Instalacao Rapida

O script automatico instala tudo no Ubuntu (Node.js, PostgreSQL, dependencias, systemd):

```bash
# 1. Clone o projeto para o servidor (usuario normal com sudo, nao root)
sudo mkdir -p /opt/captive && sudo chown $USER:$USER /opt/captive
git clone https://github.com/rafaelricado/captive.git /opt/captive
cd /opt/captive

# 2. Execute o script de instalacao
bash scripts/setup.sh
```

> **Atencao ao git clone:** use `git clone <url> /opt/captive` (com o caminho de destino).
> Se usar apenas `git clone <url>` dentro de `/opt/captive`, o projeto ficara em `/opt/captive/captive` e o servico pode nao encontrar os arquivos.

O script ira pedir:
- **Senha do banco de dados** (para o usuario `captive_user`)
- **IP do Mikrotik** (padrao: `15.1.1.1`)
- **Usuario do Mikrotik** (padrao: `captive_api`)
- **Senha do Mikrotik**
- **Duracao da sessao em horas** (padrao: `48`)
- **Usuario do painel admin** (padrao: `admin`)
- **Senha do painel admin**
- **Chave de ingestao de dados Mikrotik** (`MIKROTIK_DATA_KEY` — gerada automaticamente se deixada em branco)

O `SESSION_SECRET` e o `MIKROTIK_DATA_KEY` sao gerados automaticamente de forma segura se nao forem informados.

> **Senhas com caracteres especiais:** o script suporta qualquer caractere **exceto aspas duplas (`"`)**. Caracteres como `#`, `$`, `@`, `!` funcionam normalmente. As senhas sao gravadas com aspas no `.env` para garantir que `#` nao seja interpretado como comentario pelo dotenv.

Ao final, o servico ja estara rodando na porta 3000.

---

## Instalacao Manual

### 1. Instalar Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # deve mostrar v20.x
```

### 2. Instalar e configurar PostgreSQL

```bash
# Instalar
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Criar usuario e banco
sudo -u postgres psql
```

Dentro do psql:

```sql
CREATE USER captive_user WITH PASSWORD 'sua_senha_segura';
CREATE DATABASE captive_portal OWNER captive_user;
GRANT ALL PRIVILEGES ON DATABASE captive_portal TO captive_user;
\q
```

### 3. Configurar o projeto

```bash
cd /opt/captive    # ou o diretorio onde esta o projeto

# Instalar dependencias
npm install

# Criar arquivo de configuracao
cp .env.example .env
```

Edite o `.env` com as configuracoes corretas (veja secao abaixo).

### 4. Testar manualmente

```bash
node server.js
```

Acesse `http://<IP_DO_SERVIDOR>:3000` no navegador. Deve aparecer o formulario do portal.

### 5. Configurar como servico (systemd)

Crie o arquivo `/etc/systemd/system/captive-portal.service`:

```ini
[Unit]
Description=Captive Portal
After=network.target postgresql.service

[Service]
Type=simple
User=seu_usuario
WorkingDirectory=/opt/captive
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Ativar o servico:

```bash
sudo systemctl daemon-reload
sudo systemctl enable captive-portal
sudo systemctl start captive-portal
```

---

## Variaveis de Ambiente

Arquivo `.env` (copiar de `.env.example`):

```env
# Porta do servidor web
PORT=3000

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=captive_portal
DB_USER=captive_user
DB_PASS="sua_senha_segura"      # Use aspas para suportar # e outros caracteres especiais

# Mikrotik RouterOS API
MIKROTIK_HOST=15.1.1.1          # IP do gateway da rede de visitantes (ether2)
MIKROTIK_USER=captive_api       # Usuario criado pelo script .rsc
MIKROTIK_PASS="senha_mikrotik"  # Use aspas para suportar # e outros caracteres especiais
MIKROTIK_PORT=8728              # Porta da API (opcional, padrao: 8728)

# Duracao da sessao em horas (padrao: 48 = 2 dias)
SESSION_DURATION_HOURS=48

# Painel Administrativo
ADMIN_USER=admin                 # Usuario de acesso ao painel
ADMIN_PASSWORD="sua_senha_admin" # Use aspas para suportar # e outros caracteres especiais
SESSION_SECRET=string_longa_e_aleatoria  # Gerado automaticamente pelo setup.sh

# Ingestao de dados do Mikrotik (opcional)
MIKROTIK_DATA_KEY="sua-chave-secreta"    # Chave para autenticar envio de dados pelo roteador
```

> **Importante:** senhas com `#` devem estar entre aspas duplas no `.env`. Sem aspas, tudo apos o `#` e interpretado como comentario e a senha fica truncada. O `setup.sh` faz isso automaticamente. Se editar o `.env` manualmente, use sempre aspas nas senhas.

Gerar o `SESSION_SECRET` manualmente (se necessario):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Variaveis Obrigatorias

| Variavel | Descricao |
|----------|-----------|
| DB_HOST, DB_NAME, DB_USER, DB_PASS | Conexao com PostgreSQL |
| MIKROTIK_HOST, MIKROTIK_USER, MIKROTIK_PASS | Conexao com RouterOS API |
| ADMIN_USER, ADMIN_PASSWORD | Credenciais do painel admin |
| SESSION_SECRET | Chave de assinatura do cookie de sessao |

Variaveis com valor padrao (opcionais): `PORT`, `DB_PORT`, `MIKROTIK_PORT`, `SESSION_DURATION_HOURS`, `LOG_LEVEL` (padrao: `info`; valores validos: `error`, `warn`, `info`, `debug`), `MIKROTIK_DATA_KEY` (se vazio, o endpoint de ingestao retorna 401 para todas as requisicoes).

O servidor **nao inicia** se alguma variavel obrigatoria estiver faltando e mostra qual esta ausente.

---

## Configuracao do Mikrotik

**Importante:** Estas instrucoes sao para RouterOS v7.x (testado em v7.19 no CCR1009-7G-1C-1S+).

O script `scripts/captive_portal_ether2.rsc` configura automaticamente a rede de visitantes na porta **ether2** com a faixa `15.1.1.0/24`.

### Passo 1 - Copiar o script para o Mikrotik

**Via SCP** (do servidor Ubuntu):
```bash
scp /opt/captive/scripts/captive_portal_ether2.rsc admin@15.1.1.1:/
```

**Via Winbox:** Files > Upload > selecione `captive_portal_ether2.rsc`

### Passo 2 - Importar o script

No terminal do Mikrotik (SSH ou Winbox Terminal):

```routeros
/import file-name=captive_portal_ether2.rsc
```

O script configura automaticamente:
- IP `15.1.1.1/24` na porta ether2
- Pool DHCP `15.1.1.10-15.1.1.254` (lease 48h)
- Servidor DHCP com DNS `15.1.1.1, 1.1.1.1, 8.8.8.8`
- Hotspot na ether2 com redirect HTTP para o portal
- Firewall isolando visitantes das redes internas (`10.0.0.0/22` e `192.168.0.0/24`)
- Walled garden com deteccao de portal para iOS, Android e Windows
- Usuario `captive_api` para a API Node.js (porta 8728)

### Passo 3 - Verificar configuracao

```routeros
# IP configurado na ether2
/ip address print where interface=ether2

# Hotspot ativo
/ip hotspot print

# Walled garden
/ip hotspot walled-garden ip print

# Usuario API
/user print where name=captive_api

# API habilitada
/ip service print where name=api
```

> **Seguranca:** A API RouterOS (porta 8728) fica acessivel apenas do servidor Ubuntu (`10.0.0.56`). O script nao restringe por IP — considere aplicar manualmente: `/ip service set api address=10.0.0.56/32`

---

## Fluxo de Funcionamento

### Primeiro Acesso (Cadastro)

```
Visitante conecta Wi-Fi
        |
        v
Mikrotik intercepta navegacao
        |
        v
Redireciona para http://<servidor>:3000/?mac=XX&ip=XX&link-orig=XX
        |
        v
Visitante preenche formulario (aba "Primeiro Acesso"):
  - Nome Completo
  - CPF (validado em tempo real)
  - E-mail
  - Telefone
  - CEP (autocompletar endereco via ViaCEP)
  - Numero
  - Complemento (opcional)
        |
        v
Backend valida dados e salva no PostgreSQL
        |
        v
Backend cria sessao (expira em 48h)
        |
        v
Backend autoriza no Mikrotik via API:
  - Cria usuario no Hotspot (/ip/hotspot/user)
  - Cria IP binding bypassed (/ip/hotspot/ip-binding)
        |
        v
Redireciona para pagina de sucesso
        |
        v
Visitante navega na internet normalmente
```

### Acesso Recorrente (Login)

```
Visitante conecta Wi-Fi (sessao expirada)
        |
        v
Mikrotik redireciona para portal
        |
        v
Visitante digita CPF (aba "Ja tenho cadastro")
        |
        v
Backend busca usuario, cria nova sessao
        |
        v
Backend reautoriza no Mikrotik
        |
        v
Visitante navega normalmente por mais 48h
```

### Expiracao Automatica

```
Cron job (a cada 30 minutos)
        |
        v
Busca sessoes com expires_at < agora E active = true
        |
        v
Para cada sessao expirada:
  - Marca active = false no banco
  - Remove IP binding do Mikrotik via API
        |
        v
Visitante perde acesso, precisa reautenticar
```

---

## Banco de Dados

### Tabela `users`

| Coluna        | Tipo         | Obrigatorio | Descricao                    |
|--------------|-------------|-------------|------------------------------|
| id           | UUID        | Sim (auto)  | Identificador unico          |
| nome_completo| VARCHAR     | Sim         | Nome completo (min 3 chars)  |
| cpf          | VARCHAR(11) | Sim (unico) | CPF sem formatacao           |
| email        | VARCHAR     | Sim         | E-mail valido                |
| telefone     | VARCHAR(15) | Sim         | Telefone (10-15 digitos)     |
| cep          | VARCHAR(9)  | Sim         | CEP (8 digitos)              |
| logradouro   | VARCHAR     | Nao         | Preenchido pelo ViaCEP       |
| bairro       | VARCHAR     | Nao         | Preenchido pelo ViaCEP       |
| cidade       | VARCHAR     | Nao         | Preenchido pelo ViaCEP       |
| estado       | VARCHAR(2)  | Nao         | UF (2 chars)                 |
| numero       | VARCHAR     | Sim         | Numero do endereco           |
| complemento  | VARCHAR     | Nao         | Apto, bloco, etc.            |
| created_at   | TIMESTAMP   | Sim (auto)  | Data de criacao              |
| updated_at   | TIMESTAMP   | Sim (auto)  | Data de atualizacao          |

### Tabela `sessions`

| Coluna      | Tipo    | Obrigatorio | Descricao                      |
|------------|---------|-------------|--------------------------------|
| id         | UUID    | Sim (auto)  | Identificador unico            |
| user_id    | UUID    | Sim (FK)    | Referencia ao usuario          |
| mac_address| VARCHAR | Nao         | MAC do dispositivo             |
| ip_address | VARCHAR | Nao         | IP atribuido pelo Mikrotik     |
| started_at | TIMESTAMP| Sim (auto) | Inicio da sessao               |
| expires_at | TIMESTAMP| Sim        | Quando a sessao expira         |
| active     | BOOLEAN | Sim         | Se a sessao esta ativa         |

### Tabela `settings`

| Coluna | Tipo         | Descricao                          |
|--------|--------------|------------------------------------|
| id     | INTEGER      | Identificador                      |
| key    | VARCHAR      | Nome da configuracao (unico)       |
| value  | VARCHAR(1024)| Valor da configuracao              |

**Chaves gerenciadas pelo sistema:**

| Chave                  | Valor padrao                    | Descricao                                            |
|------------------------|---------------------------------|------------------------------------------------------|
| `session_duration_hours` | `48`                          | Duracao das sessoes de visitante em horas (1-720)    |
| `organization_name`    | `Captive Portal`                   | Nome exibido no portal e no painel admin          |
| `organization_logo`    | *(vazio)*                       | Caminho relativo da logo enviada (ex: `/uploads/logo/logo_123.png`) |
| `portal_bg_color_1`    | `#0d4e8b`                       | Cor primaria do gradiente de fundo do portal         |
| `portal_bg_color_2`    | `#1a7bc4`                       | Cor secundaria do gradiente de fundo do portal       |
| `alert_webhook_url`    | *(vazio)*                       | URL para receber alertas HTTP POST quando um AP fica offline |
| `mikrotik_data_key`    | *(vazio)*                       | Chave de autenticacao para receber dados do Mikrotik (tem prioridade sobre MIKROTIK_DATA_KEY do .env) |

Todas as configuracoes sao gerenciadas pelo painel em `/admin/settings`. Tambem e possivel alterar diretamente no banco:

```sql
-- Alterar duracao da sessao para 24h
UPDATE settings SET value = '24' WHERE key = 'session_duration_hours';

-- Alterar nome da organizacao
UPDATE settings SET value = 'Minha Empresa' WHERE key = 'organization_name';

-- Alterar cor primaria do portal
UPDATE settings SET value = '#1a5276' WHERE key = 'portal_bg_color_1';
```

### Tabela `access_points`

| Coluna      | Tipo         | Obrigatorio | Descricao                         |
|------------|-------------|-------------|-----------------------------------|
| id         | UUID        | Sim (auto)  | Identificador unico               |
| name       | VARCHAR     | Sim         | Nome amigavel do AP               |
| ip_address | VARCHAR     | Sim         | Endereco IP do ponto de acesso    |
| location   | VARCHAR     | Nao         | Localizacao fisica (sala, andar)  |
| is_online  | BOOLEAN     | Sim         | Status do ultimo ping             |
| last_seen  | TIMESTAMP   | Nao         | Ultima vez que respondeu ao ping  |
| created_at | TIMESTAMP   | Sim (auto)  | Data de cadastro                  |
| updated_at | TIMESTAMP   | Sim (auto)  | Data de atualizacao               |

### Tabela `ap_ping_history`

Armazena o historico dos resultados de ping de cada AP. Limitado a **200 registros por AP** (os mais antigos sao removidos automaticamente).

| Coluna     | Tipo      | Obrigatorio | Descricao                              |
|-----------|----------|-------------|----------------------------------------|
| id        | UUID     | Sim (auto)  | Identificador unico                    |
| ap_id     | UUID     | Sim (FK)    | Referencia ao ponto de acesso          |
| is_online | BOOLEAN  | Sim         | Se o AP respondeu ao ping              |
| latency_ms| INTEGER  | Nao         | Latencia em milissegundos (null=timeout)|
| checked_at| TIMESTAMP| Sim (auto)  | Quando o ping foi executado            |

Indice composto em `(ap_id, checked_at)` para consultas de historico eficientes.

### Tabela `traffic_rankings`

Armazena o historico de uso de banda por cliente, enviado pelo Mikrotik a cada 5 minutos. Retencao: **30 dias** (registros mais antigos removidos automaticamente na ingestao).

| Coluna       | Tipo         | Descricao                                    |
|-------------|-------------|----------------------------------------------|
| id          | UUID        | Identificador unico                          |
| ip_address  | VARCHAR     | IP do cliente na rede de visitantes          |
| hostname    | VARCHAR     | Hostname resolvido pelo roteador (pode ser nulo) |
| mac_address | VARCHAR     | Endereco MAC (pode ser nulo)                 |
| bytes_up    | BIGINT      | Bytes enviados pelo cliente (delta)          |
| bytes_down  | BIGINT      | Bytes recebidos pelo cliente (delta)         |
| router_name | VARCHAR     | Nome do roteador de origem                   |
| recorded_at | TIMESTAMP   | Quando o snapshot foi coletado               |

### Tabela `wan_stats`

Armazena o historico de estatisticas das interfaces WAN, enviado pelo Mikrotik a cada 5 minutos. Retencao: **7 dias**.

| Coluna         | Tipo      | Descricao                                    |
|---------------|----------|----------------------------------------------|
| id            | UUID     | Identificador unico                          |
| interface_name| VARCHAR  | Nome da interface (ex: `Gardeline`, `Vellon`)|
| tx_bytes      | BIGINT   | Bytes transmitidos (delta desde ultimo envio)|
| rx_bytes      | BIGINT   | Bytes recebidos (delta desde ultimo envio)   |
| is_up         | BOOLEAN  | Se a interface estava ativa no momento       |
| router_name   | VARCHAR  | Nome do roteador de origem                   |
| recorded_at   | TIMESTAMP| Quando o snapshot foi coletado               |

### Tabela `client_connections`

Armazena o **snapshot mais recente** das conexoes ativas rastreadas pelo conntrack do Mikrotik. A tabela e completamente substituida a cada envio (DELETE ALL + INSERT).

| Coluna      | Tipo      | Descricao                          |
|------------|----------|------------------------------------|
| id         | UUID     | Identificador unico                |
| src_ip     | VARCHAR  | IP de origem da conexao            |
| dst_ip     | VARCHAR  | IP de destino da conexao           |
| dst_port   | INTEGER  | Porta de destino (pode ser nulo)   |
| bytes_orig | BIGINT   | Bytes enviados na direcao original |
| bytes_reply| BIGINT   | Bytes enviados na direcao de volta |
| router_name| VARCHAR  | Nome do roteador de origem         |
| recorded_at| TIMESTAMP| Quando o snapshot foi coletado     |

### Tabela `dns_entries`

Armazena o **snapshot mais recente** do cache DNS do Mikrotik. Substituida completamente a cada envio.

| Coluna     | Tipo      | Descricao                          |
|-----------|----------|------------------------------------|
| id        | UUID     | Identificador unico                |
| domain    | VARCHAR  | Nome de dominio resolvido          |
| ip_address| VARCHAR  | IP associado ao dominio            |
| router_name| VARCHAR | Nome do roteador de origem         |
| recorded_at| TIMESTAMP| Quando o snapshot foi coletado    |

### Tabela `admin_sessions`

Criada automaticamente pelo `connect-pg-simple`. Armazena as sessoes do painel administrativo no PostgreSQL, garantindo que as sessoes persistam entre reinicializacoes do servidor. Nao e necessario interagir com ela manualmente.

---

## Rotas da API

### Portal (visitantes)

| Metodo | Rota              | Descricao                              |
|--------|-------------------|----------------------------------------|
| GET    | `/`               | Pagina do portal (cadastro/login)      |
| GET    | `/success`        | Pagina de sucesso com contador de sessao|
| POST   | `/api/register`   | Cadastro de novo usuario               |
| POST   | `/api/login`      | Login por CPF                          |
| GET    | `/api/cep/:cep`   | Consulta CEP via ViaCEP (proxy)        |
| GET    | `/health`         | Health check (status do banco e uptime)|

### Admin (painel)

| Metodo | Rota                              | Descricao                                |
|--------|-----------------------------------|------------------------------------------|
| GET    | `/admin/login`                    | Tela de login do painel                  |
| POST   | `/admin/login`                    | Autenticacao (usuario + senha)           |
| POST   | `/admin/logout`                   | Encerrar sessao admin                    |
| GET    | `/admin`                          | Dashboard com estatisticas e status WAN  |
| GET    | `/admin/users`                    | Lista paginada de usuarios               |
| GET    | `/admin/users/export`             | Exportar lista de usuarios (CSV)         |
| POST   | `/admin/users/:id/delete`         | Remover usuario (exclusao por LGPD)      |
| GET    | `/admin/sessions`                 | Lista paginada de sessoes de acesso      |
| POST   | `/admin/sessions/:id/terminate`   | Encerrar sessao de um usuario            |
| GET    | `/admin/access-points`            | Lista e monitoramento de APs             |
| POST   | `/admin/access-points`            | Adicionar ou editar ponto de acesso      |
| POST   | `/admin/access-points/ping`       | Disparar ping em todos os APs            |
| GET    | `/admin/access-points/:id/history`| Historico de ping de um AP (JSON)        |
| POST   | `/admin/access-points/:id/delete` | Remover ponto de acesso                  |
| GET    | `/admin/settings`                 | Pagina de configuracoes do portal        |
| POST   | `/admin/settings`                 | Salvar configuracoes (multipart/form)    |
| GET    | `/admin/traffic`                  | Ranking de trafego por cliente           |
| GET    | `/admin/traffic/data`             | JSON para auto-refresh da pagina (30s)   |
| GET    | `/admin/wan`                      | Estatisticas das interfaces WAN          |
| GET    | `/admin/wan/data`                 | JSON para auto-refresh da pagina (30s)   |
| GET    | `/admin/connections`              | Conexoes ativas (snapshot atual)         |
| GET    | `/admin/connections/data`         | JSON para auto-refresh da pagina (30s)   |
| GET    | `/admin/dns`                      | Cache DNS paginado com busca             |

Todas as rotas `/admin/*` (exceto login) requerem autenticacao. Sessao de admin dura 8 horas.

### Ingestao de Dados (Mikrotik)

| Metodo | Rota                          | Descricao                                           |
|--------|-------------------------------|-----------------------------------------------------|
| POST   | `/api/mikrotik/traffic`       | Recebe trafego de clientes e estatisticas WAN       |
| POST   | `/api/mikrotik/details`       | Recebe conexoes ativas e cache DNS (snapshot)       |

Autenticacao via campo `key` no body (valor igual a `MIKROTIK_DATA_KEY` no `.env`). Rate limit: 60 req/5min por IP.

> **Rate limiting em `/api/register` e `/api/login`:** maximo de **10 requisicoes por IP a cada 15 minutos**. Exceder o limite retorna HTTP 429 com mensagem em portugues no portal.

> **Rate limiting em `POST /admin/login`:** maximo de **5 tentativas por IP a cada 15 minutos** (apenas tentativas com falha contam). Protege o painel contra ataques de forca bruta.

### Detalhes

**POST /api/register** - Campos do body (form-urlencoded):

| Campo         | Obrigatorio | Descricao           |
|--------------|-------------|---------------------|
| nome_completo | Sim         | Nome completo       |
| cpf           | Sim         | CPF formatado ou nao|
| email         | Sim         | E-mail valido       |
| telefone      | Sim         | Telefone com DDD    |
| cep           | Sim         | CEP                 |
| logradouro    | Nao         | Via ViaCEP          |
| bairro        | Nao         | Via ViaCEP          |
| cidade        | Nao         | Via ViaCEP          |
| estado        | Nao         | Via ViaCEP          |
| numero        | Sim         | Numero do endereco  |
| complemento   | Nao         | Complemento         |
| mac           | Hidden      | Passado pelo Mikrotik|
| ip            | Hidden      | Passado pelo Mikrotik|
| linkOrig      | Hidden      | URL original        |

**POST /api/login** - Campos do body (form-urlencoded):

| Campo | Obrigatorio | Descricao            |
|-------|-------------|----------------------|
| cpf   | Sim         | CPF do usuario       |
| mac   | Hidden      | Passado pelo Mikrotik|
| ip    | Hidden      | Passado pelo Mikrotik|
| linkOrig | Hidden   | URL original         |

---

## Painel Administrativo

O painel permite que a equipe de TI visualize os acessos sem precisar acessar o banco diretamente.

### Acesso

```
http://<IP_DO_SERVIDOR>:3000/admin
```

Sera solicitado o usuario e a senha definidos em `ADMIN_USER` e `ADMIN_PASSWORD` no `.env`.

### Funcionalidades

| Pagina | URL | Conteudo |
|--------|-----|----------|
| Dashboard | `/admin` | Total de usuarios, sessoes ativas, novos hoje/semana; cards de status WAN (volume 24h, qualidade, online/offline); atualiza automaticamente a cada 60s |
| Usuarios | `/admin/users` | Tabela paginada: nome, CPF mascarado, e-mail, telefone, cidade/UF, data de cadastro; exportacao CSV; exclusao com remocao no Mikrotik (LGPD) |
| Sessoes | `/admin/sessions` | Tabela paginada: usuario, IP, MAC, inicio, expiracao, status (Ativa/Expirada); encerramento manual de sessao |
| Pontos de Acesso | `/admin/access-points` | Cadastro, status online/offline, ping manual, historico dos ultimos 100 pings por AP (modal com latencia) |
| Configuracoes | `/admin/settings` | Identidade visual, cores do portal, duracao da sessao, URL de webhook para alertas de AP offline |
| Trafego | `/admin/traffic` | Ranking de clientes por uso de banda (upload, download, total); dados do Mikrotik; auto-refresh a cada 30s |
| WAN | `/admin/wan` | Historico de estatisticas das interfaces WAN (TX/RX delta, status UP/DOWN); ultimas 24h; auto-refresh a cada 30s |
| Conexoes | `/admin/connections` | Snapshot das conexoes ativas rastreadas pelo conntrack (IP origem/destino, porta, bytes); auto-refresh a cada 30s |
| DNS | `/admin/dns` | Cache DNS do roteador paginado (dominio -> IP); campo de busca por dominio |

- Paginacao de 50 registros por pagina
- CPF exibido mascarado (`***.456.789-01`) para proteger dados sensiveis
- Menu de navegacao com link para cada secao e botao de logout
- Nome e logo da organizacao refletidos dinamicamente em todo o painel

### Credenciais e Sessao do Admin

- Sessao server-side armazenada no PostgreSQL (persiste entre reinicializacoes do servidor)
- Sessao assinada com `SESSION_SECRET` (nunca exposta ao cliente)
- Cookie com `httpOnly` e `sameSite: lax` (protecao contra CSRF)
- Comparacao de senha com `bcryptjs` (hash computado na inicializacao; protege contra timing attacks)
- ID de sessao regenerado apos login (previne session fixation)
- Sessao expira automaticamente apos 8 horas de inatividade
- Login limitado a 5 tentativas por IP em 15 minutos (bloqueio de forca bruta)

---

## Ingestao de Dados Mikrotik

O captive portal recebe dados de monitoramento diretamente do roteador CCR via HTTP POST, eliminando a dependencia de servicos externos (anteriormente Firebase Cloud Functions).

### Visao Geral

O roteador executa dois schedulers periodicos que enviam dados ao servidor:

| Script Mikrotik             | Frequencia | Endpoint                        |
|-----------------------------|-----------|----------------------------------|
| `traffic-ranking-send`      | 5 min     | `POST /api/mikrotik/traffic`     |
| `traffic-ranking-send-details` | 15 min | `POST /api/mikrotik/details`     |

### Autenticacao

Todas as requisicoes devem incluir o campo `key` no body com o valor igual a `MIKROTIK_DATA_KEY` configurado no `.env`. A comparacao usa `crypto.timingSafeEqual` para evitar timing attacks.

A chave pode ser sobrescrita pela configuracao `mikrotik_data_key` na tabela `settings` (editavel pelo painel em `/admin/settings`).

### Formatos de Payload

**POST /api/mikrotik/traffic** (body form-urlencoded):

| Campo  | Descricao                                                         |
|--------|-------------------------------------------------------------------|
| `key`  | Chave de autenticacao                                             |
| `router` | Nome identificador do roteador (ex: `CCR01`)                  |
| `data` | CSV de clientes: `IP,Hostname[MAC],bytes_up,bytes_down;`          |
| `iface`| CSV de interfaces: `NomeInterface,tx_delta,rx_delta,up\|down;`    |

**POST /api/mikrotik/details** (body form-urlencoded):

| Campo         | Descricao                                              |
|---------------|--------------------------------------------------------|
| `key`         | Chave de autenticacao                                  |
| `router`      | Nome identificador do roteador                         |
| `connections` | CSV: `srcIP,dstIP,dport,bytes_orig,bytes_reply;`        |
| `dns`         | CSV: `dominio>ip;`                                     |

### Configurando os Schedulers no Mikrotik

No terminal do CCR (SSH ou Winbox Terminal), atualize as URLs dos scripts existentes:

```routeros
# Editar URL do script de trafego
/system script edit traffic-ranking-send source
# Substituir a URL antiga do Firebase por:
#   http://10.0.0.56:3000/api/mikrotik/traffic

# Editar URL do script de detalhes
/system script edit traffic-ranking-send-details source
# Substituir a URL antiga do Firebase por:
#   http://10.0.0.56:3000/api/mikrotik/details
```

O campo `key` dos scripts existentes permanece identico — apenas a URL muda.

Para verificar se os schedulers estao ativos:

```routeros
/system scheduler print
```

### Retencao de Dados

| Tabela               | Estrategia          | Periodo |
|---------------------|---------------------|---------|
| `traffic_rankings`  | Historico acumulado | 30 dias |
| `wan_stats`         | Historico acumulado | 7 dias  |
| `client_connections`| Ultimo snapshot     | Substituido a cada POST |
| `dns_entries`       | Ultimo snapshot     | Substituido a cada POST |

A limpeza de `traffic_rankings` e `wan_stats` ocorre de forma assincrona durante a ingestao (nao bloqueia a resposta). A substituicao de `client_connections` e `dns_entries` e atomica (transacao Sequelize).

### Testando o Endpoint Manualmente

```bash
curl -X POST http://localhost:3000/api/mikrotik/traffic \
  -d "key=sua-chave&router=CCR01&data=10.0.1.1,TESTE[AA:BB:CC:DD:EE:FF],1048576,2097152;&iface=Gardeline,500000,1000000,up;"

# Resposta esperada: {"ok":true}
```

```bash
# Verificar dados inseridos
sudo -u postgres psql -d captive_portal -c "SELECT * FROM traffic_rankings ORDER BY recorded_at DESC LIMIT 5;"
```

---

## Personalizacao de Marca e Cores

Acesse `/admin/settings` para personalizar o portal sem editar codigo.

### Identidade Visual

| Campo | Descricao |
|-------|-----------|
| Nome da organizacao | Exibido no titulo do navegador, cabecalho do portal, painel admin e rodape |
| Logo | Upload de imagem (JPG, PNG, GIF, WebP, max 2 MB). Exibida no lugar do nome no cabecalho do portal |

Quando uma logo e cadastrada, ela substitui o texto do nome no cabecalho do portal. O nome continua sendo usado no `<title>` da pagina e no rodape.

- A logo anterior e excluida automaticamente do servidor ao fazer upload de uma nova
- Use o botao "Remover logo" para voltar a exibir o nome em texto

> **Seguranca de upload:** SVG nao e aceito (pode conter JavaScript). A validacao verifica tanto a extensao do arquivo quanto o MIME type real enviado pelo navegador.

### Cores do Portal

Dois seletores de cor definem o gradiente de fundo da pagina de portal (`portal.ejs`) e da pagina de sucesso (`success.ejs`):

| Campo | Descricao |
|-------|-----------|
| Cor primaria | Inicio e fim do gradiente diagonal (tambem usada no cabecalho e botoes) |
| Cor secundaria | Ponto central do gradiente |

A pagina de configuracoes exibe uma miniatura ao vivo do portal conforme as cores sao alteradas.

Apenas cores HEX validas no formato `#RRGGBB` sao aceitas. Valores invalidos sao rejeitados com mensagem de erro.

### Duracao da Sessao

Define por quantas horas um visitante tem acesso apos autenticacao. Valor minimo: 1h, maximo: 720h (30 dias). Padrao: 48h.

---

## Gerenciamento de Sessoes

- **Duracao padrao:** 48 horas (2 dias)
- **Verificacao:** cron job executa a cada 30 minutos
- **Expiracao:** marca sessao como inativa e remove IP binding do Mikrotik
- **Configuravel:** altere em `/admin/settings`, via `.env` (`SESSION_DURATION_HOURS`), ou diretamente no banco (`settings` key `session_duration_hours`)

A configuracao no banco (editada pelo painel) tem prioridade sobre o `.env`. O `.env` e usado apenas como valor inicial ao criar a linha no banco.

Se o valor no banco for invalido (nao-numerico ou fora do intervalo 1-720), o sistema usa 48h automaticamente.

---

## Seguranca

### Headers HTTP de seguranca

O servidor envia os seguintes headers em todas as respostas:

| Header | Valor | Protecao |
|--------|-------|----------|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline'; ...` | Bloqueia carregamento de recursos externos e injecao de scripts |
| `X-Content-Type-Options` | `nosniff` | Previne MIME sniffing pelo navegador |
| `X-Frame-Options` | `DENY` | Bloqueia o portal em iframes (anti-clickjacking) |
| `X-XSS-Protection` | `1; mode=block` | Ativa filtro XSS em navegadores legados |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limita vazamento de URL nos cabecalhos Referer |

A CSP bloqueia `frame-ancestors` (substitui `X-Frame-Options` em navegadores modernos), restringe `form-action` ao mesmo origem e proibe uso de `base-uri` externas.

### Rate limiting

| Rota | Limite | Observacao |
|------|--------|------------|
| `POST /api/register` e `POST /api/login` | 10 req / 15 min por IP | Todas as tentativas contam |
| `POST /admin/login` | 5 req / 15 min por IP | Apenas tentativas com falha contam |

Requisicoes acima do limite recebem HTTP 429. O limite e armazenado em memoria e nao persiste entre reinicializacoes do servidor.

### Validacao de redirect

O parametro `link-orig` passado pelo Mikrotik e validado no servidor com `new URL()`. Apenas URLs com protocolo `http:` ou `https:` sao aceitas, bloqueando injecao de `javascript:` ou `data:` URLs.

### Upload de logo

- Extensoes permitidas: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` (SVG proibido)
- Validacao dupla: extensao do arquivo E MIME type reportado pelo navegador
- Limite de tamanho: 2 MB
- Arquivos antigos sao excluidos do disco ao fazer upload de uma nova logo

### Mikrotik

O campo `comment` enviado ao RouterOS e sanitizado para remover caracteres especiais que poderiam causar injecao de comandos via API. Apenas letras, numeros, acentos, espacos e `.@-_` sao permitidos (maximo 100 caracteres).

---

## Comandos Uteis

### Health Check

```bash
# Verificar se o servidor e banco estao operacionais
curl http://localhost:3000/health

# Resposta esperada (HTTP 200):
# {"status":"ok","db":"ok","uptime":3600,"timestamp":"2025-01-01T12:00:00.000Z"}

# Se o banco estiver inacessivel retorna HTTP 503:
# {"status":"error","db":"unreachable","uptime":3600,"timestamp":"..."}
```

### Gerenciamento do Servico

```bash
# Ver status
sudo systemctl status captive-portal

# Iniciar
sudo systemctl start captive-portal

# Parar
sudo systemctl stop captive-portal

# Reiniciar
sudo systemctl restart captive-portal

# Ver logs em tempo real
sudo journalctl -u captive-portal -f

# Ver ultimas 100 linhas de log
sudo journalctl -u captive-portal -n 100
```

### Banco de Dados

```bash
# Acessar o banco
sudo -u postgres psql -d captive_portal

# Listar usuarios cadastrados
SELECT id, nome_completo, cpf, email, telefone, created_at FROM users ORDER BY created_at DESC;

# Ver sessoes ativas
SELECT s.id, u.nome_completo, u.cpf, s.ip_address, s.mac_address, s.started_at, s.expires_at
FROM sessions s
JOIN users u ON s.user_id = u.id
WHERE s.active = true
ORDER BY s.started_at DESC;

# Alterar tempo de sessao para 24h
UPDATE settings SET value = '24' WHERE key = 'session_duration_hours';

# Contar usuarios cadastrados
SELECT COUNT(*) FROM users;

# Expirar todas as sessoes manualmente
UPDATE sessions SET active = false WHERE active = true;
```

### Mikrotik (Terminal)

```routeros
# Ver usuarios do hotspot criados pelo portal
/ip hotspot user print where comment~"captive-portal"

# Ver IP bindings do portal
/ip hotspot ip-binding print where comment~"captive-portal"

# Remover todos os bindings do portal manualmente
/ip hotspot ip-binding remove [find comment~"captive-portal"]

# Ver conexoes ativas
/ip hotspot active print
```

---

## Troubleshooting

### Servidor nao inicia

**Erro:** `Variaveis de ambiente faltando: ...`
- Verifique se o arquivo `.env` existe e esta preenchido
- Copie de `.env.example` se necessario: `cp .env.example .env`

**Erro:** `Erro ao iniciar: connect ECONNREFUSED`
- PostgreSQL nao esta rodando: `sudo systemctl start postgresql`
- Credenciais erradas no `.env`
- Banco `captive_portal` nao existe

### Portal nao aparece no navegador

- Verifique se o servico esta rodando: `sudo systemctl status captive-portal`
- Verifique se a porta 3000 esta aberta: `sudo ss -tlnp | grep 3000`
- Firewall bloqueando: `sudo ufw allow 3000/tcp`

### Mikrotik nao redireciona para o portal

- Verifique se o Hotspot esta habilitado: `IP > Hotspot > print`
- Verifique se o Walled Garden permite acesso ao servidor
- Verifique se o `login.html` do hotspot tem o redirect correto
- Teste acessando diretamente: `http://<IP_SERVIDOR>:3000`

### Mikrotik nao autoriza (usuario cadastra mas nao navega)

- **Log mostra `Erro ao conectar`:**
  - Verifique se a API esta habilitada: `IP > Services > api`
  - Verifique se a porta 8728 esta acessivel do servidor: `telnet <IP_MIKROTIK> 8728`
  - Verifique usuario/senha no `.env`
  - Verifique se o campo `Available From` na API inclui o IP do servidor

- **Log mostra `Mikrotik nao autorizou`:**
  - Verifique permissoes do usuario API (precisa de `read`, `write`, `api`)
  - Verifique se o Hotspot Server esta configurado para `server=all` ou o server correto

### CEP nao autocompletou

- O servidor precisa de acesso a internet para consultar `viacep.com.br`
- Verifique conectividade: `curl https://viacep.com.br/ws/01001000/json/`
- Se o servidor esta atras de proxy, configure a variavel `http_proxy`

### Sessao nao expira

- Verifique se o cron job esta rodando nos logs: `[Cron] Verificando sessoes expiradas...`
- O cron roda a cada 30 minutos, pode haver um atraso de ate 30 min
- Verifique sessoes no banco: `SELECT * FROM sessions WHERE active = true;`

### Painel admin nao abre / redireciona para login

- Verifique se `ADMIN_USER`, `ADMIN_PASSWORD` e `SESSION_SECRET` estao no `.env`
- O servidor exibe qual variavel esta faltando ao iniciar

### Painel admin: "Usuario ou senha incorretos"

- Confira os valores de `ADMIN_USER` e `ADMIN_PASSWORD` no `.env` (sem espacos extras)
- O `.env` e carregado na inicializacao — reinicie o servico apos editar: `sudo systemctl restart captive-portal`

### Painel admin expira a sessao rapidamente

- A sessao dura 8 horas por padrao (contadas a partir do login)
- As sessoes sao armazenadas no PostgreSQL (tabela `admin_sessions`) e sobrevivem a reinicializacoes
- Verifique se o `SESSION_SECRET` nao mudou — alterar o segredo invalida todas as sessoes existentes

### Logo nao aparece no portal apos o upload

- Confirme que o diretorio `public/uploads/logo/` existe e tem permissao de escrita pelo usuario do servico
- Verifique nos logs se ha erro de `EACCES` ou `ENOENT` ao salvar o arquivo
- A logo e servida em `/uploads/logo/<nome_do_arquivo>` — confirme que o Express serve a pasta `public` como estatica

### Configuracoes do portal nao sao salvas

- Verifique se a tabela `settings` foi criada corretamente: `SELECT * FROM settings;`
- O `sync({ alter: true })` na inicializacao cria e ajusta as tabelas automaticamente
- Confirme que o usuario do banco tem permissao `INSERT` e `UPDATE` na tabela `settings`

### Erro 500 ao fazer login no painel admin / TypeError: Invalid URL nos logs

**Causa:** a senha do banco (`DB_PASS`) contem `#` e esta sem aspas no `.env`. O dotenv interpreta `#` como inicio de comentario e a senha fica truncada. A connection string do PostgreSQL usada pelo store de sessao recebe uma senha incorreta e falha ao montar a URL.

**Solucao:** coloque aspas duplas nas senhas no `.env`:
```env
DB_PASS="suaSenha#comHash"
MIKROTIK_PASS="outraSenha#"
ADMIN_PASSWORD="adminSenha#"
```
Reinicie o servico apos editar: `sudo systemctl restart captive-portal`

### Projeto instalado em diretorio duplicado (/opt/captive/captive)

**Causa:** executar `git clone <url>` dentro de `/opt/captive` cria `/opt/captive/captive`. O servico systemd aponta para o diretorio errado.

**Solucao:** use o caminho de destino no clone:
```bash
git clone https://github.com/rafaelricado/captive.git /opt/captive
```

Se ja instalou no diretorio errado, corrija o `WorkingDirectory` no servico:
```bash
sudo nano /etc/systemd/system/captive-portal.service
# Altere: WorkingDirectory=/opt/captive/captive
sudo systemctl daemon-reload && sudo systemctl restart captive-portal
```

### Excedeu limite de tentativas (HTTP 429)

- O rate limiter bloqueia o IP apos 10 tentativas em 15 minutos nas rotas de cadastro e login de visitantes
- No painel admin, o bloqueio ocorre apos 5 tentativas com falha em 15 minutos
- Aguarde 15 minutos ou reinicie o servidor (o limite e armazenado em memoria, nao persiste)
- Em ambiente de desenvolvimento, ajuste o limite em `routes/api.js` (visitantes) ou `routes/admin.js` (admin)

### Alertas de webhook nao chegam quando AP fica offline

- Verifique se a URL foi salva corretamente em `/admin/settings` > "Alertas de AP Offline"
- A URL deve comecar com `http://` ou `https://`
- O alerta e disparado apenas na **transicao** de online para offline; se o AP ja estava offline ao iniciar o servidor, nenhum alerta e enviado ate que ele recupere e caia novamente
- Verifique nos logs se ha erro: `[Ping] Erro ao enviar alerta de webhook`
- Teste a URL manualmente: `curl -X POST <sua_url> -H 'Content-Type: application/json' -d '{"test":true}'`

### Historico de ping do AP nao aparece no modal

- Verifique nos logs se ha erro ao salvar: `[Ping] Erro ao salvar historico do AP`
- Confirme que a tabela `ap_ping_history` existe: `SELECT COUNT(*) FROM ap_ping_history;`
- O historico e populado automaticamente a cada ciclo de ping (a cada 5 minutos); espere ao menos um ciclo
- O historico exibe no maximo os ultimos 100 registros por AP; o banco mantem os ultimos 200

### Paginas de Trafego / WAN / Conexoes nao mostram dados

- Verifique se os schedulers do Mikrotik estao ativos: `/system scheduler print`
- Confirme que a URL nos scripts aponta para o servidor correto: `http://10.0.0.56:3000/api/mikrotik/traffic`
- Teste o endpoint manualmente com `curl` (veja secao "Ingestao de Dados Mikrotik")
- Verifique a chave: `MIKROTIK_DATA_KEY` no `.env` deve coincidir com o campo `key` nos scripts do Mikrotik
- Verifique os logs: `sudo journalctl -u captive-portal -f | grep MikrotikData`
- Se a chave foi alterada no painel (`/admin/settings` > `mikrotik_data_key`), ela tem prioridade sobre o `.env`

---

## Dependencias do Projeto

O projeto utiliza 15 pacotes npm (sem dependencias adicionais para a ingestao de dados Mikrotik — o modulo `crypto` e nativo do Node.js). Abaixo a lista completa com a versao instalada e o motivo de cada dependencia.

| Pacote              | Versao   | Por que e necessario                                                                                   |
|---------------------|----------|--------------------------------------------------------------------------------------------------------|
| `express`           | ^4.21    | Framework HTTP principal. Gerencia rotas, middleware e o ciclo de requisicao/resposta do servidor.     |
| `ejs`               | ^3.1     | Template engine usada para renderizar as paginas HTML no servidor. Permite embutir variaveis e logica nas views. |
| `sequelize`         | ^6.37    | ORM que abstrai as queries SQL. Gerencia os modelos (`User`, `Session`, `Setting`, `AccessPoint`, `ApPingHistory`), migracoes via `sync({ alter: true })` e relacionamentos. |
| `pg`                | ^8.13    | Driver nativo do PostgreSQL para Node.js. Usado pelo Sequelize e pelo `connect-pg-simple` para se comunicar com o banco. |
| `pg-hstore`         | ^2.3     | Addon exigido pelo Sequelize ao usar PostgreSQL para serializar/desserializar o tipo `hstore`. Sem ele o Sequelize nao inicializa. |
| `express-session`   | ^1.18    | Gerencia a sessao server-side do painel administrativo. O ID da sessao fica num cookie assinado; os dados ficam no servidor (PostgreSQL). |
| `connect-pg-simple` | ^10.0    | Store de sessao que persiste as sessoes do painel no PostgreSQL (tabela `admin_sessions`). Sem ele as sessoes sao perdidas ao reiniciar o servidor. |
| `express-rate-limit`| ^8.2     | Aplica limite de taxa nas rotas de cadastro/login de visitantes (10 req/15 min) e no login do painel admin (5 req/15 min). |
| `multer`            | ^2.0     | Middleware para processar uploads `multipart/form-data`. Usado para receber e salvar a logo da organizacao em `/admin/settings`. |
| `node-routeros`     | ^1.6     | Cliente da API RouterOS v7 do Mikrotik. Cria usuarios no Hotspot e registros de IP binding para liberar o acesso a internet dos visitantes. |
| `axios`             | ^1.7     | Cliente HTTP usado para consultar a API publica ViaCEP (`viacep.com.br`) e preencher automaticamente o endereco ao digitar o CEP. Tambem utilizado para enviar alertas de webhook. |
| `node-cron`         | ^3.0     | Agenda tarefas repetitivas. Executa a cada 30 minutos para verificar sessoes expiradas e a cada 5 minutos para pingar os pontos de acesso cadastrados. |
| `dotenv`            | ^16.4    | Carrega as variaveis de ambiente do arquivo `.env` para `process.env` antes de qualquer outro modulo. Necessario para configurar banco, Mikrotik e segredos sem hardcodar valores no codigo. |
| `bcryptjs`          | ^2.4     | Compara a senha do painel admin com o hash bcrypt (computado na inicializacao do servidor). Protege contra ataques de timing e garante que a senha nao seja verificada em texto plano. |
| `winston`           | ^3.17    | Logger estruturado que substitui todos os `console.log/error/warn`. Formata mensagens com timestamp, nivel e cor no console. Nivel configuravel via variavel de ambiente `LOG_LEVEL`. |
