# Captive Portal - Hospital Beneficiente Portuguesa

Sistema de captive portal para autenticacao de visitantes na rede Wi-Fi, integrado com Mikrotik RouterOS v7.

Desenvolvido por **BP TI**.

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
12. [Personalizacao de Marca e Cores](#personalizacao-de-marca-e-cores)
13. [Gerenciamento de Sessoes](#gerenciamento-de-sessoes)
14. [Seguranca](#seguranca)
15. [Comandos Uteis](#comandos-uteis)
16. [Troubleshooting](#troubleshooting)
17. [Dependencias do Projeto](#dependencias-do-projeto)

> **Configuracao detalhada do Mikrotik:** veja `scripts/MIKROTIK_GUIA.md`

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
     [ ether1 ] WAN
         |
     [MIKROTIK v7.19]  192.168.1.1
         |                       |
     [ ether2 ] (ou ether3/4)  [ wlan1 ] Wi-Fi Visitantes
         |                              |
  [Ubuntu 192.168.1.10]       [Visitante 192.168.1.x]
  Captive Portal :3000                  |
  PostgreSQL :5432            Mikrotik intercepta (Hotspot)
         |                             |
         |                    login.html redireciona para :3000
         |                             |
         +<--------- cadastro / login -+
         |
         +--> Mikrotik API :8728  (autoriza ip-binding)
         |
         +--> ViaCEP API          (autocompletar CEP)

  Rede unica: 192.168.1.0/24
  Servidor usa IP fixo .10, visitantes recebem .100-.250 via DHCP
  Servidor bypassa o hotspot via ip-binding (nao precisa se autenticar)
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
│   ├── index.js                  # Inicializacao e sync do banco
│   ├── User.js                   # Modelo de usuario (cadastro)
│   ├── Session.js                # Modelo de sessao (controle de acesso)
│   └── Setting.js                # Configuracoes do sistema
│
├── middleware/
│   └── adminAuth.js              # Middleware de autenticacao do painel admin
│
├── controllers/
│   ├── portalController.js       # Renderizacao das paginas do portal
│   ├── apiController.js          # Logica de cadastro, login e CEP
│   └── adminController.js        # Logica do painel administrativo
│
├── routes/
│   ├── portal.js                 # Rotas do portal (GET /, GET /success)
│   ├── api.js                    # Rotas da API (POST /api/register, etc.)
│   └── admin.js                  # Rotas do painel admin (/admin/*)
│
├── services/
│   ├── mikrotikService.js        # Integracao com RouterOS API v7
│   └── sessionService.js         # Criacao e expiracao de sessoes
│
├── utils/
│   └── cpfValidator.js           # Validacao de CPF (algoritmo digitos verificadores)
│
├── views/
│   ├── portal.ejs                # Pagina principal (cadastro + login)
│   ├── success.ejs               # Pagina de sucesso apos autenticacao
│   └── admin/
│       ├── login.ejs             # Tela de login do painel
│       ├── dashboard.ejs         # Dashboard com estatisticas
│       ├── users.ejs             # Lista de usuarios cadastrados
│       ├── sessions.ejs          # Lista de sessoes de acesso
│       ├── settings.ejs          # Pagina de configuracoes do portal
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
    ├── setup.sh                  # Script de instalacao automatica (Ubuntu)
    ├── mikrotik_setup.rsc        # Script de configuracao do Mikrotik (RouterOS v7)
    ├── MIKROTIK_GUIA.md          # Guia detalhado de configuracao do Mikrotik
    └── hotspot/                  # Paginas HTML servidas pelo Mikrotik Hotspot
        ├── login.html            # Redireciona visitante para o portal externo
        ├── alogin.html           # Exibida apos autenticacao bem-sucedida
        ├── logout.html           # Exibida ao desconectar
        ├── error.html            # Exibida em caso de erro do hotspot
        └── redirect.html         # Redirect interno do hotspot
```

---

## Instalacao Rapida

O script automatico instala tudo no Ubuntu (Node.js, PostgreSQL, dependencias, systemd):

```bash
# 1. Clone ou copie o projeto para o servidor
cd /opt
git clone <url-do-repositorio> captive
cd captive

# 2. De permissao e execute o script
chmod +x scripts/setup.sh
./scripts/setup.sh
```

O script ira pedir:
- **Senha do banco de dados** (para o usuario `captive_user`)
- **IP do Mikrotik** (padrao: 192.168.1.1)
- **Usuario do Mikrotik** (padrao: captive_api)
- **Senha do Mikrotik**
- **Duracao da sessao em horas** (padrao: 48)
- **Usuario do painel admin** (padrao: admin)
- **Senha do painel admin**

O `SESSION_SECRET` e gerado automaticamente de forma segura.

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
Description=Captive Portal - Hospital Beneficiente Portuguesa
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
DB_PASS=sua_senha_segura

# Mikrotik RouterOS API
MIKROTIK_HOST=192.168.1.1       # IP do Mikrotik
MIKROTIK_USER=captive_api       # Usuario com permissao API
MIKROTIK_PASS=senha_mikrotik    # Senha do usuario
MIKROTIK_PORT=8728              # Porta da API (opcional, padrao: 8728)

# Duracao da sessao em horas (padrao: 48 = 2 dias)
SESSION_DURATION_HOURS=48

# Painel Administrativo
ADMIN_USER=admin                # Usuario de acesso ao painel
ADMIN_PASSWORD=sua_senha_admin  # Senha de acesso ao painel
SESSION_SECRET=string_longa_e_aleatoria  # Gerado automaticamente pelo setup.sh
```

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

Variaveis com valor padrao (opcionais): `PORT`, `DB_PORT`, `MIKROTIK_PORT`, `SESSION_DURATION_HOURS`.

O servidor **nao inicia** se alguma variavel obrigatoria estiver faltando e mostra qual esta ausente.

---

## Configuracao do Mikrotik

**Importante:** Estas instrucoes sao para RouterOS v7.x (testado em v7.19).

Para configuracao completa e detalhada, incluindo passo a passo com Winbox,
topologias alternativas e troubleshooting, consulte:

> **`scripts/MIKROTIK_GUIA.md`**

### Resumo rapido (Mikrotik zerado)

### Passo 1 - Copiar arquivos para o Mikrotik (via Winbox > Files)

Crie a pasta `hotspot` no Mikrotik e copie todos os arquivos de `scripts/hotspot/`.
Depois copie `scripts/mikrotik_setup.rsc` para a raiz.

### Passo 2 - Editar variaveis e importar o script

Edite as variaveis no inicio de `mikrotik_setup.rsc` e execute no terminal:

```routeros
/import file-name=mikrotik_setup.rsc
```

### Passo 3 - Criar o Hotspot (referencia manual)

Acesse o Mikrotik via **Winbox** ou **WebFig**.

```
IP > Hotspot > Hotspot Setup
```

Siga o assistente selecionando:
- **Hotspot Interface:** a interface wireless dos visitantes
- **Local Address of Network:** o IP do gateway (ex: 10.0.0.1/24)
- **Address Pool:** pool de IPs para visitantes
- **DNS Name:** (pode deixar em branco ou colocar `portal.local`)

### Passo 2 - Configurar Server Profile

```
IP > Hotspot > Server Profiles > (selecione o profile criado)
```

Na aba **Login**:
- **Login By:** marque `HTTP CHAP`
- Desmarque `Cookie` (para forcar reautenticacao apos expirar)
- **HTTP PAP:** desabilitado

Na aba **General**:
- **HTML Directory Override:** deixe vazio (usaremos login externo)

### Passo 3 - Configurar pagina de login externa

No **Hotspot Server Profile**, na aba **Login**, configure o campo **Login Page** (ou via terminal):

```routeros
/ip hotspot profile set [find name=seu_profile] login-by=http-chap html-directory-override=""
```

Para redirecionar para o captive portal externo, edite o arquivo `login.html` do hotspot ou use Walled Garden com redirect.

**Via Terminal** (metodo recomendado - redirect automatico):

```routeros
/ip hotspot walled-garden ip
add action=accept dst-address=<IP_DO_SERVIDOR_UBUNTU>
add action=accept dst-address=0.0.0.0/0 dst-port=53 protocol=udp comment="DNS"
```

No **Hotspot Server**, configure a URL de login:

```routeros
/ip hotspot set [find] login-by=http-chap
```

Crie/edite o arquivo `login.html` no hotspot para redirecionar:

```html
<html>
<head>
<meta http-equiv="refresh" content="0;url=http://<IP_SERVIDOR>:3000/?mac=$(mac)&ip=$(ip)&username=$(username)&link-orig=$(link-orig)">
</head>
</html>
```

**Parametros passados pelo Mikrotik:**

| Parametro     | Descricao                               |
|--------------|----------------------------------------|
| `$(mac)`      | MAC address do dispositivo do visitante |
| `$(ip)`       | IP atribuido ao visitante              |
| `$(username)` | Nome de usuario (se houver)            |
| `$(link-orig)`| URL original que o visitante tentou acessar |

### Passo 4 - Configurar Walled Garden

Permitir que visitantes nao autenticados acessem o servidor do portal:

```routeros
/ip hotspot walled-garden ip
add action=accept dst-address=<IP_DO_SERVIDOR_UBUNTU> comment="Captive Portal Server"
add action=accept dst-address=0.0.0.0/0 dst-port=53 protocol=udp comment="DNS para todos"
```

**Via WebFig/Winbox:**

```
IP > Hotspot > Walled Garden > IP List > Add
- Action: accept
- Dst. Address: <IP_DO_SERVIDOR_UBUNTU>
- Comment: Captive Portal Server
```

### Passo 5 - Habilitar API do RouterOS

```routeros
/ip service set api address=<IP_DO_SERVIDOR_UBUNTU>/32 disabled=no port=8728
```

**Via WebFig/Winbox:**

```
IP > Services
- api: habilitado, porta 8728
- Available From: <IP_DO_SERVIDOR_UBUNTU> (restrinja por seguranca!)
```

### Passo 6 - Criar usuario para API

```routeros
/user add name=captive_api password=sua_senha_api group=full comment="Captive Portal API"
```

**Via WebFig/Winbox:**

```
System > Users > Add
- Name: captive_api
- Password: sua_senha_api
- Group: full (ou grupo customizado com permissao api, read, write)
- Comment: Captive Portal API
```

> **Seguranca:** Restrinja o acesso da API apenas ao IP do servidor Ubuntu. Nunca deixe a API aberta para toda a rede.

### Passo 7 - Verificar configuracao

No terminal do Mikrotik, verifique:

```routeros
# Verificar hotspot
/ip hotspot print

# Verificar server profile
/ip hotspot profile print

# Verificar walled garden
/ip hotspot walled-garden ip print

# Verificar API
/ip service print where name=api

# Verificar usuario
/user print where name=captive_api
```

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
| `organization_name`    | `Hospital Beneficiente Portuguesa` | Nome exibido no portal e no painel admin          |
| `organization_logo`    | *(vazio)*                       | Caminho relativo da logo enviada (ex: `/uploads/logo/logo_123.png`) |
| `portal_bg_color_1`    | `#0d4e8b`                       | Cor primaria do gradiente de fundo do portal         |
| `portal_bg_color_2`    | `#1a7bc4`                       | Cor secundaria do gradiente de fundo do portal       |

Todas as configuracoes sao gerenciadas pelo painel em `/admin/settings`. Tambem e possivel alterar diretamente no banco:

```sql
-- Alterar duracao da sessao para 24h
UPDATE settings SET value = '24' WHERE key = 'session_duration_hours';

-- Alterar nome da organizacao
UPDATE settings SET value = 'Minha Empresa' WHERE key = 'organization_name';

-- Alterar cor primaria do portal
UPDATE settings SET value = '#1a5276' WHERE key = 'portal_bg_color_1';
```

### Tabela `admin_sessions`

Criada automaticamente pelo `connect-pg-simple`. Armazena as sessoes do painel administrativo no PostgreSQL, garantindo que as sessoes persistam entre reinicializacoes do servidor. Nao e necessario interagir com ela manualmente.

---

## Rotas da API

### Portal (visitantes)

| Metodo | Rota              | Descricao                              |
|--------|-------------------|----------------------------------------|
| GET    | `/`               | Pagina do portal (cadastro/login)      |
| GET    | `/success`        | Pagina de sucesso                      |
| POST   | `/api/register`   | Cadastro de novo usuario               |
| POST   | `/api/login`      | Login por CPF                          |
| GET    | `/api/cep/:cep`   | Consulta CEP via ViaCEP (proxy)        |

### Admin (painel)

| Metodo | Rota                | Descricao                              |
|--------|---------------------|----------------------------------------|
| GET    | `/admin/login`      | Tela de login do painel                |
| POST   | `/admin/login`      | Autenticacao (usuario + senha)         |
| POST   | `/admin/logout`     | Encerrar sessao admin                  |
| GET    | `/admin`            | Dashboard com estatisticas             |
| GET    | `/admin/users`      | Lista paginada de usuarios             |
| GET    | `/admin/sessions`   | Lista paginada de sessoes de acesso    |
| GET    | `/admin/settings`   | Pagina de configuracoes do portal      |
| POST   | `/admin/settings`   | Salvar configuracoes (multipart/form)  |

Todas as rotas `/admin/*` (exceto login) requerem autenticacao. Sessao de admin dura 8 horas.

> **Rate limiting em `/api/register` e `/api/login`:** maximo de 10 requisicoes por IP a cada 15 minutos. Exceder o limite retorna HTTP 429 com mensagem em portugues no portal.

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
| Dashboard | `/admin` | Total de usuarios, sessoes ativas agora, novos hoje, novos na semana |
| Usuarios | `/admin/users` | Tabela paginada: nome, CPF mascarado, e-mail, telefone, cidade/UF, data de cadastro |
| Sessoes | `/admin/sessions` | Tabela paginada: usuario, IP, MAC, inicio, expiracao, status (Ativa/Expirada) |
| Configuracoes | `/admin/settings` | Identidade visual, cores do portal, duracao da sessao |

- Paginacao de 50 registros por pagina
- CPF exibido mascarado (`***.456.789-01`) para proteger dados sensiveis
- Menu de navegacao com link para cada secao e botao de logout
- Nome e logo da organizacao refletidos dinamicamente em todo o painel

### Credenciais e Sessao do Admin

- Sessao server-side armazenada no PostgreSQL (persiste entre reinicializacoes do servidor)
- Sessao assinada com `SESSION_SECRET` (nunca exposta ao cliente)
- Cookie com `httpOnly` e `sameSite: lax` (protecao contra CSRF)
- Comparacao de senha em tempo constante (previne timing attacks)
- ID de sessao regenerado apos login (previne session fixation)
- Sessao expira automaticamente apos 8 horas de inatividade

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
| `X-Content-Type-Options` | `nosniff` | Previne MIME sniffing pelo navegador |
| `X-Frame-Options` | `DENY` | Bloqueia o portal em iframes (anti-clickjacking) |
| `X-XSS-Protection` | `1; mode=block` | Ativa filtro XSS em navegadores legados |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limita vazamento de URL nos cabecalhos Referer |

### Rate limiting

As rotas `/api/register` e `/api/login` aceitam no maximo **10 requisicoes por IP a cada 15 minutos**. Requisicoes acima do limite recebem HTTP 429 e o portal exibe a mensagem em portugues.

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

### Excedeu limite de tentativas (HTTP 429)

- O rate limiter bloqueia o IP apos 10 tentativas em 15 minutos nas rotas de cadastro e login
- Aguarde 15 minutos ou reinicie o servidor (o limite e armazenado em memoria, nao persiste)
- Em ambiente de desenvolvimento, ajuste o limite em `routes/api.js`

---

## Dependencias do Projeto

O projeto utiliza 13 pacotes npm. Abaixo a lista completa com a versao instalada e o motivo de cada dependencia.

| Pacote              | Versao   | Por que e necessario                                                                                   |
|---------------------|----------|--------------------------------------------------------------------------------------------------------|
| `express`           | ^4.21    | Framework HTTP principal. Gerencia rotas, middleware e o ciclo de requisicao/resposta do servidor.     |
| `ejs`               | ^3.1     | Template engine usada para renderizar as paginas HTML no servidor. Permite embutir variaveis e logica nas views. |
| `sequelize`         | ^6.37    | ORM que abstrai as queries SQL. Gerencia os modelos (`User`, `Session`, `Setting`), migracoes via `sync({ alter: true })` e relacionamentos. |
| `pg`                | ^8.13    | Driver nativo do PostgreSQL para Node.js. Usado pelo Sequelize e pelo `connect-pg-simple` para se comunicar com o banco. |
| `pg-hstore`         | ^2.3     | Addon exigido pelo Sequelize ao usar PostgreSQL para serializar/desserializar o tipo `hstore`. Sem ele o Sequelize nao inicializa. |
| `express-session`   | ^1.18    | Gerencia a sessao server-side do painel administrativo. O ID da sessao fica num cookie assinado; os dados ficam no servidor (PostgreSQL). |
| `connect-pg-simple` | ^10.0    | Store de sessao que persiste as sessoes do painel no PostgreSQL (tabela `admin_sessions`). Sem ele as sessoes sao perdidas ao reiniciar o servidor. |
| `express-rate-limit`| ^8.2     | Aplica limite de taxa (10 req / 15 min por IP) nas rotas `/api/register` e `/api/login`, bloqueando ataques de forca bruta e spam. |
| `multer`            | ^2.0     | Middleware para processar uploads `multipart/form-data`. Usado para receber e salvar a logo da organizacao em `/admin/settings`. |
| `node-routeros`     | ^1.6     | Cliente da API RouterOS v7 do Mikrotik. Cria usuarios no Hotspot e registros de IP binding para liberar o acesso a internet dos visitantes. |
| `axios`             | ^1.7     | Cliente HTTP usado para consultar a API publica ViaCEP (`viacep.com.br`) e preencher automaticamente o endereco ao digitar o CEP. |
| `node-cron`         | ^3.0     | Agenda tarefas repetitivas. Executa a cada 30 minutos para verificar sessoes expiradas, marca-las como inativas e remover os IP bindings do Mikrotik. |
| `dotenv`            | ^16.4    | Carrega as variaveis de ambiente do arquivo `.env` para `process.env` antes de qualquer outro modulo. Necessario para configurar banco, Mikrotik e segredos sem hardcodar valores no codigo. |
