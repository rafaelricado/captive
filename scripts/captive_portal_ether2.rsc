#############################################################
# Captive Portal - Rede de Visitantes
# Interface: ether2
# Faixa:     15.1.1.0/24  (gateway 15.1.1.1)
# Testado em: RouterOS v7.x (CCR1009-7G-1C-1S+)
#
# Para rodar:
#   Copie para o Mikrotik e execute:
#        /import file-name=captive_portal_ether2.rsc
#
# O script eh seguro para rodar em producao:
# NAO altera configuracoes existentes de ether3/ether4/ether5/ether6
#############################################################

# IP do servidor Ubuntu na rede interna
:local ubuntuIP     "10.0.0.56"
# Senha do usuario captive_api
:local apiPass      "JTU2850rf#"
:local guestNet     "15.1.1.0/24"
:local guestGW      "15.1.1.1"
:local guestMask    "24"
:local dhcpPool     "15.1.1.10-15.1.1.254"
# 48h - alinhar com SESSION_DURATION_HOURS no servidor
:local leaseTime    "2d"
:local iface        "ether2"
:local hsProfile    "captive-profile"
:local hsName       "portal-visitantes"
:local apiUser      "captive_api"

:log info "=== Captive Portal: iniciando configuracao em ether2 ==="
:put    "=== Captive Portal: iniciando configuracao em ether2 ==="

#------------------------------------------------------------
# [1/8] IP no ether2
#------------------------------------------------------------
:put "[1/8] Configurando IP em ether2..."
/ip address
:if ([find interface=$iface] = "") do={
  add address=($guestGW . "/" . $guestMask) interface=$iface \
      comment="Captive Portal - gateway visitantes"
  :put "    OK: $guestGW/$guestMask adicionado em $iface"
} else={
  :put "    SKIP: IP ja existe em $iface"
}

#------------------------------------------------------------
# [2/8] Pool e servidor DHCP para visitantes
#------------------------------------------------------------
:put "[2/8] Configurando DHCP para visitantes..."
/ip pool
:if ([find name="pool-visitantes"] = "") do={
  add name="pool-visitantes" ranges=$dhcpPool \
      comment="Captive Portal - pool visitantes"
} else={
  :put "    SKIP: pool-visitantes ja existe"
}

/ip dhcp-server network
:if ([find address=$guestNet] = "") do={
  add address=$guestNet gateway=$guestGW dns-server=($guestGW . ",1.1.1.1,8.8.8.8") \
      comment="Captive Portal - rede visitantes"
} else={
  :put "    SKIP: rede DHCP $guestNet ja existe"
}

/ip dhcp-server
:if ([find name="dhcp-visitantes"] = "") do={
  add name="dhcp-visitantes" interface=$iface address-pool="pool-visitantes" \
      lease-time=$leaseTime disabled=no \
      comment="Captive Portal - servidor DHCP visitantes"
  :put "    OK: DHCP servidor criado"
} else={
  :put "    SKIP: dhcp-visitantes ja existe"
}

#------------------------------------------------------------
# [3/8] DNS local para a faixa de visitantes
#------------------------------------------------------------
:put "[3/8] Habilitando DNS no router para visitantes..."
/ip dns
:if (![get allow-remote-requests]) do={
  set allow-remote-requests=yes
  :put "    OK: allow-remote-requests habilitado"
} else={
  :put "    SKIP: DNS ja habilitado"
}

#------------------------------------------------------------
# [4/8] Firewall - isolamento e redirecionamento HTTP
#------------------------------------------------------------
:put "[4/8] Configurando firewall..."

# --- Isolar visitantes das redes internas (FORWARD) ---
/ip firewall filter

# EXCECAO: visitantes precisam alcançar o servidor do portal para autenticar.
# Esta regra deve ficar ANTES dos drops abaixo.
:if ([find comment="CP: permitir visitantes -> servidor captive portal"] = "") do={
  add chain=forward src-address=$guestNet dst-address=$ubuntuIP \
      action=accept place-before=0 \
      comment="CP: permitir visitantes -> servidor captive portal"
  :put "    OK: acesso ao servidor $ubuntuIP liberado para autenticacao"
}

:if ([find comment="CP: bloquear visitantes -> LAN interna 10.0.0.0/22"] = "") do={
  add chain=forward src-address=$guestNet dst-address=10.0.0.0/22 \
      action=drop place-before=0 \
      comment="CP: bloquear visitantes -> LAN interna 10.0.0.0/22"
  :put "    OK: bloqueio visitantes -> 10.0.0.0/22"
}

:if ([find comment="CP: bloquear visitantes -> LAN interna 192.168.0.0/16"] = "") do={
  add chain=forward src-address=$guestNet dst-address=192.168.0.0/16 \
      action=drop place-before=0 \
      comment="CP: bloquear visitantes -> LAN interna 192.168.0.0/16"
  :put "    OK: bloqueio visitantes -> 192.168.0.0/16"
}

# --- Isolar LANs internas das visitas (retorno bloqueado) ---
:if ([find comment="CP: bloquear LAN interna -> visitantes"] = "") do={
  add chain=forward src-address=10.0.0.0/22 dst-address=$guestNet \
      action=drop place-before=0 \
      comment="CP: bloquear LAN interna -> visitantes"
  add chain=forward src-address=192.168.0.0/16 dst-address=$guestNet \
      action=drop place-before=0 \
      comment="CP: bloquear LAN interna -> visitantes"
  :put "    OK: isolamento bidirecional configurado"
}

# --- Redirecionar HTTP dos visitantes para o portal (antes da autenticacao) ---
/ip firewall nat
:if ([find comment="CP: redirecionar HTTP visitantes para portal"] = "") do={
  add chain=dstnat src-address=$guestNet protocol=tcp dst-port=80 \
      action=dst-nat to-addresses=$ubuntuIP to-ports=3000 \
      comment="CP: redirecionar HTTP visitantes para portal"
  :put "    OK: redirect HTTP -> $ubuntuIP:3000"
}

:put "    OK: firewall configurado"

#------------------------------------------------------------
# [5/8] Hotspot na interface ether2
#------------------------------------------------------------
:put "[5/8] Configurando Hotspot em ether2..."

/ip hotspot profile
:if ([find name=$hsProfile] = "") do={
  add name=$hsProfile \
      hotspot-address=$guestGW \
      dns-name="" \
      html-directory=hotspot \
      login-by=http-chap,http-pap \
      http-proxy=0.0.0.0:0 \
      use-radius=no \
      comment="Captive Portal - perfil hotspot visitantes"
  :put "    OK: perfil hotspot criado"
} else={
  :put "    SKIP: perfil $hsProfile ja existe"
}

/ip hotspot
:if ([find name=$hsName] = "") do={
  add name=$hsName interface=$iface address-pool="pool-visitantes" \
      profile=$hsProfile disabled=no \
      comment="Captive Portal - hotspot visitantes"
  :put "    OK: hotspot $hsName criado em $iface"
} else={
  :put "    SKIP: hotspot $hsName ja existe"
}

#------------------------------------------------------------
# [6/8] Walled Garden - liberar acesso ao portal sem login
#------------------------------------------------------------
:put "[6/8] Configurando Walled Garden..."

/ip hotspot walled-garden ip
:if ([find comment="CP: acesso ao servidor captive portal"] = "") do={
  add dst-address=$ubuntuIP action=accept \
      comment="CP: acesso ao servidor captive portal"
  :put "    OK: $ubuntuIP liberado no walled garden"
}

/ip hotspot walled-garden
# DNS e NTP livres (necessarios para autenticacao funcionar em iOS/Android)
:if ([find comment="CP: DNS livre"] = "") do={
  add dst-host="*.apple.com" action=allow comment="CP: iOS captive detection"
  add dst-host="captive.apple.com" action=allow comment="CP: iOS captive detection"
  add dst-host="connectivitycheck.gstatic.com" action=allow comment="CP: Android captive detection"
  add dst-host="clients3.google.com" action=allow comment="CP: Android captive detection"
  add dst-host="www.msftconnecttest.com" action=allow comment="CP: Windows captive detection"
  :put "    OK: deteccao de portal para iOS/Android/Windows configurada"
}

#------------------------------------------------------------
# [7/8] Usuario API para o Node.js
#------------------------------------------------------------
:put "[7/8] Criando usuario API..."
/user
:if ([find name=$apiUser] = "") do={
  add name=$apiUser password=$apiPass group=full \
      comment="Captive Portal API - Node.js"
  :put "    OK: usuario $apiUser criado"
} else={
  set [find name=$apiUser] password=$apiPass
  :put "    OK: senha do usuario $apiUser atualizada"
}

# Garantir que a API esta habilitada na porta 8728
/ip service
:if ([find name=api and disabled=yes] != "") do={
  set [find name=api] disabled=no
  :put "    OK: servico API habilitado na porta 8728"
} else={
  :put "    SKIP: servico API ja habilitado"
}

#------------------------------------------------------------
# [8/8] Resumo
#------------------------------------------------------------
:put ""
:put "============================================================"
:put "  Captive Portal - CONFIGURACAO CONCLUIDA"
:put "============================================================"
:put ""
:put "  Rede visitantes : $guestNet"
:put "  Gateway         : $guestGW"
:put "  Interface       : $iface"
:put "  DHCP pool       : $dhcpPool"
:put "  Lease time      : $leaseTime"
:put "  Servidor portal : $ubuntuIP:3000"
:put ""
:put "  PROXIMO PASSO:"
:put "  Configure no .env do servidor Ubuntu:"
:put "    MIKROTIK_HOST=$guestGW"
:put "    MIKROTIK_USER=$apiUser"
:put "    MIKROTIK_PORT=8728"
:put ""
:put "  Conecte um switch/AP na porta ether2 para testar."
:put "============================================================"

:log info "=== Captive Portal: configuracao em ether2 finalizada ==="
