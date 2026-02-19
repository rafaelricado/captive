# ===========================================================
# Captive Portal - Hospital Beneficiente Portuguesa
# Script de Configuracao Mikrotik - RouterOS v7.x
# Testado em RouterOS v7.19
# ===========================================================
#
# PRE-REQUISITO OBRIGATORIO antes de importar este script:
#   Copie a pasta "hotspot" (com os arquivos .html) para o
#   Mikrotik via Winbox > Files. Sem esses arquivos o
#   redirecionamento para o portal nao funcionara.
#
# COMO USAR:
#   1. Edite as variaveis na secao abaixo
#   2. Copie os arquivos scripts/hotspot/ para o Mikrotik (Winbox > Files)
#   3. Copie este arquivo para o Mikrotik (Winbox > Files)
#   4. No terminal do Mikrotik: /import file-name=mikrotik_setup.rsc
#
# ===========================================================
#
# VARIAVEIS - EDITE CONFORME SUA REDE
# ===========================================================

# Interfaces de rede
:local wanInterface    "ether1"   # Porta ligada ao link de internet (provedor)
:local lanInterface    "ether2"   # Porta ligada ao servidor Ubuntu (qualquer porta LAN livre)
:local wifiInterface   "wlan1"    # Interface Wi-Fi dos visitantes
                                  # (se usar AP externo via cabo, use a porta do AP aqui)

# Endereçamento da rede (visitantes E servidor ficam na mesma rede)
:local lanIP           "192.168.1.1"    # IP do Mikrotik (gateway da rede)
:local lanPrefix       "192.168.1.0/24" # Rede completa com mascara
:local dhcpRange       "192.168.1.100-192.168.1.250" # IPs dinamicos para visitantes

# Servidor Ubuntu (Captive Portal)
# DEVE ser um IP FIXO fora do pool DHCP acima (ex: .2 a .99 estao livres)
# Configure este mesmo IP no Ubuntu via netplan (veja o guia MIKROTIK_GUIA.md)
:local portalIP        "192.168.1.10"  # IP fixo do servidor Ubuntu
:local portalPort      "3000"          # Porta do portal

# Wi-Fi (so se usar wireless embutido no Mikrotik)
:local wifiSSID        "Wi-Fi Visitantes - Hospital BP"
:local wifiCountry     "brazil"
# Para rede aberta (sem senha) deixe wifiPassword vazio: ""
# Para rede com senha WPA2 coloque a senha abaixo:
:local wifiPassword    ""

# DNS publico para os visitantes
:local dnsServer1      "8.8.8.8"
:local dnsServer2      "8.8.4.4"

# Usuario e senha para a API do Captive Portal
# ATENÇÃO: Use a mesma senha no arquivo .env do servidor Ubuntu
:local apiUser         "captive_api"
:local apiPassword     "ALTERE_ESTA_SENHA_AQUI"

# Nomes internos (nao precisa alterar)
:local hotspotProfile  "captive-profile"
:local hotspotName     "portal-bp"
:local bridgeName      "bridge-visitantes"

# ===========================================================
# FIM DAS VARIAVEIS
# Nao edite abaixo, a menos que saiba o que esta fazendo
# ===========================================================

:log info "=== Captive Portal BP: Iniciando configuracao ==="
:put "=== Captive Portal BP: Iniciando configuracao ==="

# -----------------------------------------------------------
# 1. IDENTIDADE
# -----------------------------------------------------------
/system identity set name="MK-Hospital-BP"
:log info "=== [1/10] Identidade: MK-Hospital-BP ==="

# -----------------------------------------------------------
# 2. BRIDGE - agrupamento de todas as portas LAN + Wi-Fi
#
# Servidor Ubuntu, visitantes Wi-Fi e demais portas LAN ficam
# todos na mesma rede (192.168.1.0/24).
# O servidor e diferenciado pelo IP fixo + ip-binding bypass.
# -----------------------------------------------------------
/interface bridge
add name=$bridgeName protocol-mode=rstp comment="Bridge rede interna"

# Adicionar porta do servidor Ubuntu ao bridge
/interface bridge port
add bridge=$bridgeName interface=$lanInterface comment="Servidor Ubuntu"

# Adicionar wireless ao bridge (com protecao contra falha se nao existir)
:do {
  /interface bridge port add bridge=$bridgeName interface=$wifiInterface \
    comment="Wi-Fi visitantes"
  :log info "=== [2/10] Wireless adicionado ao bridge ==="
} on-error={
  :log warning "=== [2/10] Interface $wifiInterface nao encontrada - use AP externo ==="
  :put "AVISO: $wifiInterface nao encontrada. Se usar AP externo, ignore este aviso."
}

:log info "=== [2/10] Bridge configurada ==="

# -----------------------------------------------------------
# 3. ENDERECOS IP
# -----------------------------------------------------------

# WAN - DHCP client no link de internet
/ip dhcp-client
add interface=$wanInterface disabled=no comment="WAN - link internet"

# IP do Mikrotik na rede (gateway de todos: visitantes + servidor)
/ip address
add address=($lanIP . "/24") interface=$bridgeName comment="Gateway rede interna"

:log info "=== [3/10] Enderecos IP configurados ==="
:put "INFO: Mikrotik IP: $lanIP | Servidor Ubuntu deve ter IP fixo: $portalIP"
:put "INFO: Configure o IP $portalIP no Ubuntu via netplan (veja MIKROTIK_GUIA.md)"

# -----------------------------------------------------------
# 4. DHCP SERVER - distribui IPs para visitantes
# -----------------------------------------------------------
/ip pool
add name=pool-visitantes ranges=$dhcpRange

/ip dhcp-server
add name=dhcp-visitantes interface=$bridgeName \
  address-pool=pool-visitantes lease-time=2h disabled=no

/ip dhcp-server network
add address=$lanPrefix gateway=$lanIP \
  dns-server=($dnsServer1 . "," . $dnsServer2) \
  comment="Rede visitantes"

:log info "=== [4/10] DHCP Server configurado ==="

# -----------------------------------------------------------
# 5. DNS
# -----------------------------------------------------------
/ip dns
set servers=($dnsServer1 . "," . $dnsServer2) allow-remote-requests=yes

:log info "=== [5/10] DNS configurado ==="

# -----------------------------------------------------------
# 6. NAT - saida para internet
# -----------------------------------------------------------
/ip firewall nat
add chain=srcnat out-interface=$wanInterface action=masquerade \
  comment="NAT - saida internet"

:log info "=== [6/10] NAT configurado ==="

# -----------------------------------------------------------
# 7. WIRELESS (somente se usar wireless embutido do Mikrotik)
# -----------------------------------------------------------
:do {
  # Configurar perfil de seguranca
  :if ([:len $wifiPassword] > 0) do={
    /interface wireless security-profiles
    set default mode=dynamic-keys authentication-types=wpa2-psk \
      wpa2-pre-shared-key=$wifiPassword
    :log info "=== [7/10] Wireless: WPA2 configurado ==="
  } else={
    /interface wireless security-profiles
    set default mode=none
    :log info "=== [7/10] Wireless: rede aberta (sem senha) ==="
  }

  # Configurar interface wireless
  /interface wireless
  set $wifiInterface \
    mode=ap-bridge \
    ssid=$wifiSSID \
    band=2ghz-b/g/n \
    channel-width=20/40mhz-Ce \
    country=$wifiCountry \
    wireless-protocol=any \
    disabled=no

  :log info "=== [7/10] Wireless configurado: SSID=$wifiSSID ==="
} on-error={
  :log warning "=== [7/10] Wireless nao configurado (interface inexistente ou sem suporte) ==="
}

# -----------------------------------------------------------
# 8. HOTSPOT
#
# REQUISITO: os arquivos HTML da pasta "hotspot" ja devem
# estar no filesystem do Mikrotik antes de importar este script.
# Verifique com: /file print where name~"hotspot"
# -----------------------------------------------------------

# Servidor Ubuntu bypassa o hotspot (ele nao precisa se autenticar)
/ip hotspot ip-binding
add address=$portalIP type=bypassed \
  comment="Servidor Captive Portal - bypass hotspot"

# Perfil do hotspot
# html-directory=hotspot aponta para a pasta /hotspot/ no filesystem
/ip hotspot profile
add name=$hotspotProfile \
  hotspot-address=$lanIP \
  html-directory=hotspot \
  http-cookie-lifetime=0s \
  login-by=http-chap \
  use-radius=no \
  dns-name="" \
  smtp-server=0.0.0.0

# Servidor hotspot na bridge dos visitantes
/ip hotspot
add name=$hotspotName \
  interface=$bridgeName \
  address-pool=pool-visitantes \
  profile=$hotspotProfile \
  disabled=no

# Walled Garden IP - permite acesso ao servidor do portal SEM autenticacao
/ip hotspot walled-garden ip
add action=accept dst-address=$portalIP \
  comment="Captive Portal - acesso livre"
add action=accept dst-address=0.0.0.0/0 protocol=udp dst-port=53 \
  comment="DNS UDP livre"
add action=accept dst-address=0.0.0.0/0 protocol=tcp dst-port=53 \
  comment="DNS TCP livre"

# Walled Garden HTTP - permite paginas do servidor do portal sem redirecionar
/ip hotspot walled-garden
add dst-host=$portalIP action=allow \
  comment="Captive Portal HTTP"

:log info "=== [8/10] Hotspot configurado ==="

# -----------------------------------------------------------
# 9. PERFIL DE USUARIO DO HOTSPOT
# -----------------------------------------------------------
/ip hotspot user profile
set default \
  idle-timeout=15m \
  keepalive-timeout=2m \
  shared-users=1 \
  status-autorefresh=1m \
  transparent-proxy=no

:log info "=== [9/10] Perfil de usuario configurado ==="

# -----------------------------------------------------------
# 10. SERVICOS E USUARIO DA API
# -----------------------------------------------------------

# Habilitar API restrita ao servidor Ubuntu
# (adapte o address se o servidor estiver em outro IP)
/ip service
set api     disabled=no port=8728 address=($portalIP . "/32")
set api-ssl disabled=yes
set telnet  disabled=yes
set ftp     disabled=yes
set www     disabled=no
set ssh     disabled=no
set winbox  disabled=no

# Criar usuario da API
:do {
  /user add name=$apiUser password=$apiPassword group=full \
    comment="Captive Portal API - Hospital BP"
  :log info "=== [10/10] Usuario API '$apiUser' criado ==="
} on-error={
  :log warning "=== [10/10] Usuario '$apiUser' ja existe, atualizando senha ==="
  /user set [find name=$apiUser] password=$apiPassword
}

# -----------------------------------------------------------
# FIREWALL
# -----------------------------------------------------------
/ip firewall filter

# --- INPUT (protege o proprio Mikrotik) ---

# Aceitar estabelecidos/relacionados
add chain=input action=accept connection-state=established,related \
  comment="Input: aceitar estabelecidos"

# Aceitar ICMP (ping para diagnose)
add chain=input action=accept protocol=icmp \
  comment="Input: ICMP"

# Aceitar todo acesso vindo do servidor do portal (API, Winbox, etc)
add chain=input action=accept src-address=$portalIP \
  comment="Input: servidor captive portal"

# Aceitar DHCP
add chain=input action=accept protocol=udp dst-port=67-68 \
  comment="Input: DHCP"

# Aceitar DNS da rede interna
add chain=input action=accept protocol=udp dst-port=53 in-interface=!$wanInterface \
  comment="Input: DNS UDP interno"
add chain=input action=accept protocol=tcp dst-port=53 in-interface=!$wanInterface \
  comment="Input: DNS TCP interno"

# Aceitar Winbox da rede LAN
add chain=input action=accept protocol=tcp dst-port=8291 in-interface=!$wanInterface \
  comment="Input: Winbox (LAN)"

# Aceitar SSH da rede LAN
add chain=input action=accept protocol=tcp dst-port=22 in-interface=!$wanInterface \
  comment="Input: SSH (LAN)"

# Aceitar WebFig da rede LAN
add chain=input action=accept protocol=tcp dst-port=80 in-interface=!$wanInterface \
  comment="Input: WebFig (LAN)"

# Bloquear tudo da WAN que nao foi aceito
add chain=input action=drop in-interface=$wanInterface \
  comment="Input: bloquear WAN"

# --- FORWARD ---

# Aceitar estabelecidos/relacionados
add chain=forward action=accept connection-state=established,related \
  comment="Forward: aceitar estabelecidos"

# Bloquear inválidos
add chain=forward action=drop connection-state=invalid \
  comment="Forward: bloquear invalidos"

:log info "=== Firewall configurado ==="

# -----------------------------------------------------------
# RESUMO FINAL
# -----------------------------------------------------------
:log info " "
:log info "======================================================="
:log info "  CONFIGURACAO CONCLUIDA - Hospital Beneficiente BP"
:log info "======================================================="
:log info "  Gateway visitantes : $lanIP"
:log info "  Hotspot            : $hotspotName"
:log info "  SSID               : $wifiSSID"
:log info "  Portal             : http://$portalIP:$portalPort"
:log info "  API user           : $apiUser  porta: 8728"
:log info "======================================================="
:log info " "
:log info "PROXIMO PASSO:"
:log info "  1. Verifique se os arquivos hotspot HTML estao em /hotspot/"
:log info "     /file print where name~hotspot"
:log info "  2. Verifique o hotspot: /ip hotspot print"
:log info "  3. Configure o servidor Ubuntu com IP $portalIP"
:log info "     (ou o IP que definiu em portalIP)"
:log info "======================================================="

:put ""
:put "=== CONFIGURACAO CONCLUIDA ==="
:put "Hotspot: $hotspotName | Portal: http://$portalIP:$portalPort"
:put "Verifique os logs: /log print"
