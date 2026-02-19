# Guia Completo - Configuracao do Mikrotik (Zerado)

RouterOS v7.x | Hospital Beneficiente Portuguesa | BP TI

---

## Topologia de Rede

```
[Internet / Provedor]
         |
     [ ether1 ] -- WAN (DHCP client, recebe IP do provedor)
         |
     [MIKROTIK RouterOS v7.19]
         |                    |
     [ ether2 ]          [ wlan1 ] -- Wi-Fi "Wi-Fi Visitantes - Hospital BP"
         |                                    |
  [Ubuntu IP: 192.168.1.10]           [Visitantes: 192.168.1.100-250]
  (Captive Portal :3000)
         |
         \--- mesma bridge (192.168.1.0/24) ---/
```

Servidor Ubuntu e visitantes ficam na **mesma rede** (`192.168.1.0/24`).
O servidor usa um **IP fixo** fora do pool DHCP (`.10`).
O Mikrotik Hotspot o reconhece pelo IP e o deixa passar sem autenticacao (ip-binding bypass).

> **Nao precisa de porta dedicada.** O servidor pode ser ligado em qualquer porta LAN livre
> do Mikrotik (ether2, ether3, ether4...). Basta configurar o IP fixo no Ubuntu.

---

## Arquivos necessarios

Estes arquivos ficam em `scripts/` no projeto:

```
scripts/
├── mikrotik_setup.rsc       # Script principal de configuracao
├── MIKROTIK_GUIA.md         # Este guia
└── hotspot/
    ├── login.html            # Pagina de redirect para o portal externo  (OBRIGATORIO)
    ├── alogin.html           # Pagina apos autenticacao bem-sucedida     (OBRIGATORIO)
    ├── logout.html           # Pagina de logout                          (OBRIGATORIO)
    ├── error.html            # Pagina de erro do hotspot                 (OBRIGATORIO)
    └── redirect.html         # Pagina de redirect interno                (OBRIGATORIO)
```

---

## Passo 1 — Editar as variaveis do script

Abra `scripts/mikrotik_setup.rsc` e edite o bloco de variaveis no inicio:

```routeros
:local wanInterface    "ether1"          # Porta do link de internet
:local lanInterface    "ether2"          # Porta do servidor Ubuntu
:local wifiInterface   "wlan1"           # Interface Wi-Fi dos visitantes
:local lanIP           "192.168.1.1"     # IP do Mikrotik (gateway visitantes)
:local lanPrefix       "192.168.1.0/24"  # Rede dos visitantes
:local dhcpRange       "192.168.1.100-192.168.1.250"
:local portalIP        "192.168.1.10"    # IP do servidor Ubuntu
:local portalPort      "3000"
:local wifiSSID        "Wi-Fi Visitantes - Hospital BP"
:local wifiPassword    ""                # Deixe vazio para rede aberta
:local dnsServer1      "8.8.8.8"
:local dnsServer2      "8.8.4.4"
:local apiUser         "captive_api"
:local apiPassword     "ALTERE_ESTA_SENHA_AQUI"  # TROQUE ESTA SENHA
```

---

## Passo 2 — Editar o IP do portal nas paginas HTML

Em **todos** os arquivos dentro de `scripts/hotspot/`, substitua `192.168.1.10`
pelo IP real do servidor Ubuntu.

Arquivos que precisam de edicao:
- `hotspot/login.html` → linha `var PORTAL_SERVER = "http://192.168.1.10:3000";`
- `hotspot/alogin.html` → linha `var PORTAL_SERVER = "http://192.168.1.10:3000";`
- `hotspot/error.html` → link `href="http://192.168.1.10:3000/"`

---

## Passo 3 — Copiar arquivos para o Mikrotik

### Via Winbox (recomendado)

1. Abra o **Winbox** e conecte ao Mikrotik (IP padrao ao zerado: `192.168.88.1`, user: `admin`, sem senha)
2. Va em **Files**
3. Clique com botao direito > **Create Directory** > nome: `hotspot`
4. Arraste os 5 arquivos de `scripts/hotspot/` para dentro da pasta `hotspot`:
   - `login.html`
   - `alogin.html`
   - `logout.html`
   - `error.html`
   - `redirect.html`
5. Arraste o arquivo `mikrotik_setup.rsc` para a raiz (fora da pasta hotspot)

**Verificar se os arquivos estao la:**
```
/file print where name~"hotspot"
```

### Via SCP (alternativa — se o Mikrotik ja tiver IP)

Do servidor Ubuntu ou de um PC na rede:
```bash
scp scripts/mikrotik_setup.rsc admin@192.168.88.1:/
scp scripts/hotspot/login.html   admin@192.168.88.1:/hotspot/
scp scripts/hotspot/alogin.html  admin@192.168.88.1:/hotspot/
scp scripts/hotspot/logout.html  admin@192.168.88.1:/hotspot/
scp scripts/hotspot/error.html   admin@192.168.88.1:/hotspot/
scp scripts/hotspot/redirect.html admin@192.168.88.1:/hotspot/
```

---

## Passo 4 — Importar o script de configuracao

Abra o terminal do Mikrotik (Winbox > **New Terminal**):

```routeros
/import file-name=mikrotik_setup.rsc
```

Acompanhe a saida. Voce deve ver:

```
=== [1/10] Identidade: MK-Hospital-BP ===
=== [2/10] Bridge configurada ===
=== [3/10] Enderecos IP configurados ===
=== [4/10] DHCP Server configurado ===
=== [5/10] DNS configurado ===
=== [6/10] NAT configurado ===
=== [7/10] Wireless configurado: SSID=Wi-Fi Visitantes - Hospital BP ===
=== [8/10] Hotspot configurado ===
=== [9/10] Perfil de usuario configurado ===
=== [10/10] Usuario API 'captive_api' criado ===
=== CONFIGURACAO CONCLUIDA ===
```

---

## Passo 5 — Configurar IP fixo no servidor Ubuntu

O servidor precisa de um **IP fixo** na mesma rede dos visitantes, fora do pool DHCP.
O pool DHCP vai de `.100` a `.250`, entao qualquer IP entre `.2` e `.99` esta disponivel.
O script usa `192.168.1.10` como padrao.

### Como descobrir o nome da interface de rede do Ubuntu

```bash
ip link show
# Procure a interface diferente de "lo" (loopback)
# Exemplos: eth0, ens18, enp3s0, ens3
```

### Configurar IP fixo via Netplan (Ubuntu 20.04+)

Crie ou edite o arquivo de netplan:

```bash
sudo nano /etc/netplan/01-captive.yaml
```

Conteudo:

```yaml
network:
  version: 2
  ethernets:
    ens18:              # Substitua pelo nome real da sua interface
      dhcp4: false
      addresses:
        - 192.168.1.10/24    # IP fixo do servidor (fora do pool DHCP .100-.250)
      routes:
        - to: default
          via: 192.168.1.1   # Gateway = IP do Mikrotik
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
```

Aplicar:

```bash
sudo netplan apply

# Verificar
ip addr show ens18
ping -c 3 192.168.1.1    # Deve responder (Mikrotik)
```

### Conectar o cabo

Ligue o cabo de rede do servidor Ubuntu em **qualquer porta LAN livre** do Mikrotik
(`ether2`, `ether3`, `ether4`, etc.). Todas estao na mesma bridge e funcionam igual.

> **Resumo:** IP do servidor = `192.168.1.10`, mascara = `/24`, gateway = `192.168.1.1`

---

## Passo 6 — Verificar toda a configuracao

### No Mikrotik (terminal):

```routeros
# Hotspot rodando?
/ip hotspot print
# Resultado esperado: Name=portal-bp, Interface=bridge-visitantes, Running=yes

# Walled garden correto?
/ip hotspot walled-garden ip print
# Deve mostrar o IP do servidor como "accept"

# Bypass do servidor?
/ip hotspot ip-binding print
# Deve mostrar o IP do servidor como "bypassed"

# API habilitada?
/ip service print where name=api
# Deve mostrar: disabled=no, port=8728, address=<IP_SERVIDOR>

# Usuario API existe?
/user print where name=captive_api

# Arquivos HTML no lugar certo?
/file print where name~"hotspot"
# Deve listar: hotspot/login.html, hotspot/alogin.html, etc.

# DHCP funcionando?
/ip dhcp-server print
# Deve mostrar dhcp-visitantes rodando
```

### No servidor Ubuntu:

```bash
# Portal rodando?
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
# Deve retornar: 200

# Mikrotik alcancavel?
ping -c 3 192.168.1.1
# Deve responder

# Porta da API acessivel?
nc -zv 192.168.1.1 8728
# Deve mostrar: Connection succeeded
```

---

## Passo 7 — Teste completo

1. Conecte um celular ou notebook no Wi-Fi `"Wi-Fi Visitantes - Hospital BP"`
2. O dispositivo deve receber IP no range `192.168.1.100-250`
3. Abra o navegador e acesse qualquer site **HTTP** (ex: `http://neverssl.com`)
4. Deve ser redirecionado para o formulario do Captive Portal
5. Preencha o cadastro e clique em **Cadastrar e Conectar**
6. Deve aparecer a tela de sucesso
7. Navegue normalmente — deve funcionar

---

## Dicas de Topologia

### Caso 1: Mikrotik COM wireless embutido (ex: hAP ac, RB951)
Configuracao descrita acima funciona diretamente. O `wlan1` e a interface dos visitantes.

### Caso 2: Mikrotik SEM wireless (ex: RB750, hEX) + AP externo
Ligue o AP externo em `ether3` (ou qualquer porta livre). Edite o script:
```routeros
:local wifiInterface   "ether3"   # Porta onde o AP esta ligado
```
O AP externo deve ser configurado em modo bridge (transparente), sem DHCP proprio.

### Caso 3: Servidor Ubuntu na mesma porta que os visitantes
Se nao tiver como separar o servidor em uma porta diferente, edite o script
para colocar `ether2` na bridge junto com `wlan1`, e adicione manualmente
o bypass do IP do servidor:
```routeros
/ip hotspot ip-binding add address=192.168.1.10 type=bypassed comment="Servidor portal"
```
E ajuste o servidor para ter IP fixo `192.168.1.10` via DHCP static ou netplan.

---

## Troubleshooting

### Hotspot nao aparece / nao redireciona

```routeros
/ip hotspot print
```
Se `Running=no`, verifique:
- A interface do hotspot existe: `/interface print`
- O pool de IPs esta criado: `/ip pool print`

### Pagina de login nao carrega (tela em branco ou erro)

```routeros
/file print where name~"hotspot"
```
Se os arquivos nao aparecerem, eles nao foram copiados corretamente para o Mikrotik.
Repita o Passo 3.

### Redireciona mas mostra "conexao recusada" no portal

- Verifique se o servidor Ubuntu esta rodando: `sudo systemctl status captive-portal`
- Verifique se o walled garden esta correto: `/ip hotspot walled-garden ip print`
- Verifique se o bypass do servidor esta configurado: `/ip hotspot ip-binding print`

### Cadastra mas nao navega (sem internet apos cadastro)

```bash
# No servidor Ubuntu, verificar logs do portal
sudo journalctl -u captive-portal -f
```
Se aparecer `Mikrotik nao autorizou`:
- Teste a API: `nc -zv <IP_MIKROTIK> 8728`
- Verifique usuario/senha em `.env` (MIKROTIK_USER, MIKROTIK_PASS)
- Verifique o campo `address` do servico API: `/ip service print where name=api`

### API "connection refused"

```routeros
/ip service set api address=""
```
Remove a restricao de IP (so para teste). Se funcionar, o problema e que o IP do
servidor no `.env` nao bate com o IP que o Mikrotik ve chegando.
Depois restrinja novamente com o IP correto.
