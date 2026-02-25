# ============================================================
# RANKING DE TRÁFEGO - COLETA E ENVIO PARA SERVIDOR LOCAL
# Router: CCR1009-7G-1C-1S+ | RouterOS 7.20.6
# ============================================================
# Usa Mangle Rules com passthrough em custom chains para
# contabilizar tráfego individual de cada IP da rede.
# As regras ficam em chains separadas (RANKING-UP, RANKING-DN)
# acessadas via jump do forward (início da chain), onde os
# IPs já estão corretos após NAT/masquerade.
#
# A cada 5 minutos, lê os contadores de bytes e envia para
# o servidor local do Captive Portal (10.0.0.56:3000).
#
# O painel admin exibe o ranking dos equipamentos que mais
# consomem internet em tempo real.
#
# APLICAÇÃO: /import file-name=traffic_ranking.rsc
# ============================================================


# ============================================================
# PASSO 0 - LIMPEZA DE CONFIGURAÇÃO ANTERIOR
# ============================================================

:do { /system scheduler remove [find name="traffic-ranking-scheduler"] } on-error={}
:do { /system scheduler remove [find name="traffic-ranking-sync"] } on-error={}
:do { /system scheduler remove [find name="traffic-ranking-details"] } on-error={}
:do { /system script remove [find name="traffic-ranking-send"] } on-error={}
:do { /system script remove [find name="traffic-ranking-sync-queues"] } on-error={}
:do { /system script remove [find name="traffic-ranking-send-details"] } on-error={}
:do {
    :foreach q in=[/queue simple find where comment~"RANKING:"] do={
        /queue simple remove $q
    }
} on-error={}
:do { :foreach r in=[/ip firewall mangle find where comment~"RANKING"] do={ /ip firewall mangle remove $r } } on-error={}
:do { /ip firewall address-list remove [find where list="RANKING-local"] } on-error={}

:log info "RANKING: Limpeza concluida"


# ============================================================
# PASSO 1 - ADDRESS-LIST E JUMP RULES (MANGLE)
# ============================================================
# Cria address-list com redes privadas para excluir tráfego
# local-para-local. Cria 2 jump rules no chain prerouting
# que direcionam tráfego internet para custom chains
# RANKING-UP (upload) e RANKING-DN (download).
#
# Usa chain=forward onde os IPs já estão corretos após NAT.
# As jump rules são colocadas NO INÍCIO do forward chain
# (place-before) para garantir que rodam antes de QoS existente.
# action=jump não interfere - ao terminar o custom chain,
# o processamento retorna ao forward normalmente.

/ip firewall address-list add list=RANKING-local address=10.0.0.0/8 comment="RANKING: Rede privada A"
/ip firewall address-list add list=RANKING-local address=192.168.0.0/16 comment="RANKING: Rede privada C"
/ip firewall address-list add list=RANKING-local address=172.16.0.0/12 comment="RANKING: Rede privada B"

# Adiciona jump rules e depois move para o inicio do forward chain
# Ordem: primeiro adiciona DN, depois UP, move UP para 0, move DN para 0
# Resultado final: DN=pos0, UP=pos1 (ambas antes do QoS)
# ATENÇÃO: ajuste $localNet para a subnet da sua rede local.
:local localNet "10.0.0.0/22"
/ip firewall mangle add chain=forward dst-address=$localNet src-address-list=!RANKING-local action=jump jump-target=RANKING-DN comment="RANKING: Jump download internet"
/ip firewall mangle add chain=forward src-address=$localNet dst-address-list=!RANKING-local action=jump jump-target=RANKING-UP comment="RANKING: Jump upload internet"

# Move UP para posicao 0 (topo absoluto da lista mangle)
:local upRule [/ip firewall mangle find where comment="RANKING: Jump upload internet"]
:if ([:len $upRule] > 0) do={
    /ip firewall mangle move $upRule destination=0
    :log info "RANKING: Jump upload movida para posicao 0"
} else={
    :log warning "RANKING: Regra upload nao encontrada para mover"
}

# Move DN para posicao 0 (empurra UP para posicao 1)
:local dnRule [/ip firewall mangle find where comment="RANKING: Jump download internet"]
:if ([:len $dnRule] > 0) do={
    /ip firewall mangle move $dnRule destination=0
    :log info "RANKING: Jump download movida para posicao 0 (upload fica em 1)"
} else={
    :log warning "RANKING: Regra download nao encontrada para mover"
}

:log info "RANKING: Address-list e jump rules criados (chain=forward)"


# ============================================================
# PASSO 2 - SCRIPT DE SINCRONIZAÇÃO DE MANGLE RULES
# ============================================================
# Lê os DHCP leases ativos e cria regras mangle por IP nos
# custom chains RANKING-UP e RANKING-DN.
# Cada regra usa action=passthrough para apenas contar bytes
# sem modificar ou bloquear o pacote.
# Regras de leases expirados são removidas automaticamente.

/system script add name="traffic-ranking-sync-queues" policy=read,write,test source="\
:local leaseIPs [:toarray \"\"]\r\
\r\
:foreach lease in=[/ip dhcp-server lease find where status=bound] do={\r\
    :do {\r\
        :local ip [/ip dhcp-server lease get \$lease address]\r\
        :if (\$ip = \"\" or [:find \$ip \".\" 0] = nothing) do={\r\
            :log warning (\"RANKING: Lease ignorado - IP invalido\")\r\
        } else={\r\
            :local host [/ip dhcp-server lease get \$lease host-name]\r\
            :local mac [/ip dhcp-server lease get \$lease mac-address]\r\
            :if (\$host = \"\") do={ :set host \$mac }\r\
            :local safeHost \"\"\r\
            :for i from=0 to=([:len \$host] - 1) do={\r\
                :local ch [:pick \$host \$i (\$i + 1)]\r\
                :if (\$ch = \"&\" or \$ch = \"=\" or \$ch = \",\" or \$ch = \";\") do={\r\
                    :set safeHost (\$safeHost . \"_\")\r\
                } else={\r\
                    :set safeHost (\$safeHost . \$ch)\r\
                }\r\
            }\r\
            :set host \$safeHost\r\
            :set (\$leaseIPs->\$ip) 1\r\
\r\
            # Cria regra de upload (RANKING-UP) se nao existe\r\
            :local upComment (\"RANKING-UP: \" . \$ip . \" \" . \$host . \" [\" . \$mac . \"]\")\r\
            :local existingUp [/ip firewall mangle find where chain=\"RANKING-UP\" src-address=\$ip]\r\
            :if ([:len \$existingUp] = 0) do={\r\
                :do { /ip firewall mangle add chain=RANKING-UP src-address=\$ip action=passthrough comment=\$upComment } on-error={\r\
                    :log warning (\"RANKING: Falha ao criar regra UP para \" . \$ip)\r\
                }\r\
            }\r\
\r\
            # Cria regra de download (RANKING-DN) se nao existe\r\
            :local dnComment (\"RANKING-DN: \" . \$ip . \" \" . \$host . \" [\" . \$mac . \"]\")\r\
            :local existingDn [/ip firewall mangle find where chain=\"RANKING-DN\" dst-address=\$ip]\r\
            :if ([:len \$existingDn] = 0) do={\r\
                :do { /ip firewall mangle add chain=RANKING-DN dst-address=\$ip action=passthrough comment=\$dnComment } on-error={\r\
                    :log warning (\"RANKING: Falha ao criar regra DN para \" . \$ip)\r\
                }\r\
                :log info (\"RANKING: Regras criadas para \" . \$ip . \" (\" . \$host . \")\")\r\
            }\r\
        }\r\
    } on-error={}\r\
}\r\
\r\
# Remove regras de leases expirados\r\
:foreach r in=[/ip firewall mangle find where chain=\"RANKING-UP\" comment~\"RANKING-UP:\"] do={\r\
    :local rAddr [/ip firewall mangle get \$r src-address]\r\
    :if ([:typeof (\$leaseIPs->\$rAddr)] = \"nothing\") do={\r\
        :local dnRule [/ip firewall mangle find where chain=\"RANKING-DN\" dst-address=\$rAddr]\r\
        :if ([:len \$dnRule] > 0) do={ /ip firewall mangle remove \$dnRule }\r\
        /ip firewall mangle remove \$r\r\
        :log info (\"RANKING: Regras removidas (lease expirado): \" . \$rAddr)\r\
    }\r\
}\r\
\r\
:log info (\"RANKING: Sync concluido\")\
"


# ============================================================
# PASSO 3 - SCRIPT DE COLETA E ENVIO
# ============================================================
# Lê os contadores de bytes das mangle rules por IP e envia
# via HTTP POST para o servidor local (Captive Portal).
#
# Formato CSV: ip,info,uploadBytes,downloadBytes;...
#
# Upload = bytes da regra RANKING-UP (src = IP local)
# Download = bytes da regra RANKING-DN (dst = IP local)
#
# Após envio, reseta os contadores das regras mangle.

/system script add name="traffic-ranking-send" policy=read,write,test source="\
:local serverUrl \"http://10.0.0.56:3000/api/mikrotik/traffic\"\r\
:local apiKey \"c3d5ee363e0b3fbc3dc12777f13bf437c2613207\"\r\
\r\
:local data \"\"\r\
:local count 0\r\
\r\
# Coleta hostnames para info\r\
:local hostMap [:toarray \"\"]\r\
:foreach lease in=[/ip dhcp-server lease find where status=bound] do={\r\
    :local ip [/ip dhcp-server lease get \$lease address]\r\
    :local host [/ip dhcp-server lease get \$lease host-name]\r\
    :local mac [/ip dhcp-server lease get \$lease mac-address]\r\
    :if (\$host = \"\") do={ :set host \$mac }\r\
    :local safeHost \"\"\r\
    :for i from=0 to=([:len \$host] - 1) do={\r\
        :local ch [:pick \$host \$i (\$i + 1)]\r\
        :if (\$ch = \"&\" or \$ch = \"=\" or \$ch = \",\" or \$ch = \";\") do={\r\
            :set safeHost (\$safeHost . \"_\")\r\
        } else={\r\
            :set safeHost (\$safeHost . \$ch)\r\
        }\r\
    }\r\
    :set (\$hostMap->\$ip) (\$safeHost . \" [\" . \$mac . \"]\")\r\
}\r\
\r\
# Le contadores de upload (RANKING-UP)\r\
:local uploadMap [:toarray \"\"]\r\
:foreach r in=[/ip firewall mangle find where chain=\"RANKING-UP\" comment~\"RANKING-UP:\"] do={\r\
    :do {\r\
        :local ip [/ip firewall mangle get \$r src-address]\r\
        :local bytes [/ip firewall mangle get \$r bytes]\r\
        :if (\$bytes > 0) do={\r\
            :set (\$uploadMap->\$ip) \$bytes\r\
        }\r\
    } on-error={}\r\
}\r\
\r\
# Le contadores de download (RANKING-DN)\r\
:local downloadMap [:toarray \"\"]\r\
:foreach r in=[/ip firewall mangle find where chain=\"RANKING-DN\" comment~\"RANKING-DN:\"] do={\r\
    :do {\r\
        :local ip [/ip firewall mangle get \$r dst-address]\r\
        :local bytes [/ip firewall mangle get \$r bytes]\r\
        :if (\$bytes > 0) do={\r\
            :set (\$downloadMap->\$ip) \$bytes\r\
        }\r\
    } on-error={}\r\
}\r\
\r\
# Monta CSV: combina upload e download por IP\r\
:local allIPs [:toarray \"\"]\r\
:foreach ip,v in=\$uploadMap do={ :set (\$allIPs->\$ip) 1 }\r\
:foreach ip,v in=\$downloadMap do={ :set (\$allIPs->\$ip) 1 }\r\
\r\
:foreach ip,v in=\$allIPs do={\r\
    :local ul (\$uploadMap->\$ip)\r\
    :local dl (\$downloadMap->\$ip)\r\
    :if ([:typeof \$ul] = \"nothing\") do={ :set ul 0 }\r\
    :if ([:typeof \$dl] = \"nothing\") do={ :set dl 0 }\r\
    :local info (\$hostMap->\$ip)\r\
    :if ([:typeof \$info] = \"nothing\") do={ :set info \"\" }\r\
    :set data (\$data . \$ip . \",\" . \$info . \",\" . \$ul . \",\" . \$dl . \";\")\r\
    :set count (\$count + 1)\r\
}\r\
\r\
:if (\$count > 0) do={\r\
    :local routerName [/system identity get name]\r\
\r\
    # Dados de interfaces WAN (delta desde ultima execucao)\r\
    :local ifaceData \"\"\r\
    :do {\r\
        :local e5rx [/interface get ether5 rx-byte]\r\
        :local e5tx [/interface get ether5 tx-byte]\r\
        :global rankPrevE5rx\r\
        :global rankPrevE5tx\r\
        :local deltaRx 0\r\
        :local deltaTx 0\r\
        :if ([:typeof \$rankPrevE5rx] != \"nothing\") do={\r\
            :if (\$e5rx >= \$rankPrevE5rx) do={ :set deltaRx (\$e5rx - \$rankPrevE5rx) } else={ :set deltaRx \$e5rx }\r\
            :if (\$e5tx >= \$rankPrevE5tx) do={ :set deltaTx (\$e5tx - \$rankPrevE5tx) } else={ :set deltaTx \$e5tx }\r\
        }\r\
        :set rankPrevE5rx \$e5rx\r\
        :set rankPrevE5tx \$e5tx\r\
        :local e5status \"down\"\r\
        :if ([/interface get ether5 running]) do={ :set e5status \"up\" }\r\
        :set ifaceData (\"Gardeline,\" . \$deltaTx . \",\" . \$deltaRx . \",\" . \$e5status . \";\")\r\
    } on-error={}\r\
    :do {\r\
        :local vlrx [/interface get Vellon rx-byte]\r\
        :local vltx [/interface get Vellon tx-byte]\r\
        :global rankPrevVlrx\r\
        :global rankPrevVltx\r\
        :local deltaRx 0\r\
        :local deltaTx 0\r\
        :if ([:typeof \$rankPrevVlrx] != \"nothing\") do={\r\
            :if (\$vlrx >= \$rankPrevVlrx) do={ :set deltaRx (\$vlrx - \$rankPrevVlrx) } else={ :set deltaRx \$vlrx }\r\
            :if (\$vltx >= \$rankPrevVltx) do={ :set deltaTx (\$vltx - \$rankPrevVltx) } else={ :set deltaTx \$vltx }\r\
        }\r\
        :set rankPrevVlrx \$vlrx\r\
        :set rankPrevVltx \$vltx\r\
        :local vlstatus \"down\"\r\
        :if ([/interface get Vellon running]) do={ :set vlstatus \"up\" }\r\
        :set ifaceData (\$ifaceData . \"Vellon,\" . \$deltaTx . \",\" . \$deltaRx . \",\" . \$vlstatus . \";\")\r\
    } on-error={}\r\
\r\
    :local sendData (\"key=\" . \$apiKey . \"&router=\" . \$routerName . \"&data=\" . \$data . \"&iface=\" . \$ifaceData)\r\
\r\
    :local sendOk 1\r\
    :do {\r\
        /tool fetch url=\$serverUrl mode=http http-method=post http-data=\$sendData http-header-field=\"Content-Type: application/x-www-form-urlencoded\" output=none\r\
        :log info (\"RANKING: Enviados \" . \$count . \" registros para servidor local\")\r\
    } on-error={\r\
        :set sendOk 0\r\
        :log error \"RANKING: Falha ao enviar dados para servidor local\"\r\
    }\r\
\r\
    # Reseta contadores apos envio bem-sucedido\r\
    :if (\$sendOk = 1) do={\r\
        /ip firewall mangle reset-counters [find where chain~\"RANKING-\"]\r\
    } else={\r\
        :log warning \"RANKING: Contadores mantidos (envio falhou)\"\r\
    }\r\
} else={\r\
    :log info \"RANKING: Nenhum registro com trafego para enviar\"\r\
}\
"


# ============================================================
# PASSO 4 - SCRIPT DE DETALHES (DESTINOS POR DISPOSITIVO)
# ============================================================
# Coleta conexões ativas + cache DNS do router.
# Envia para o servidor local que cruza os dados e identifica
# quais sites/serviços cada dispositivo está acessando.
# Conexões com destino local (10.x, 192.168.x, 172.16-31.x)
# são ignoradas - apenas destinos internet são enviados.
#
# Formato conexões: srcIP,dstIP,dstPort,origBytes,replBytes;...
# Formato DNS:      domain>ip;domain>ip;...
#
# Roda a cada 15 minutos (menos frequente que o tráfego).

/system script add name="traffic-ranking-send-details" policy=read,write,test source="\
:local serverUrl \"http://10.0.0.56:3000/api/mikrotik/details\"\r\
:local apiKey \"c3d5ee363e0b3fbc3dc12777f13bf437c2613207\"\r\
\r\
:local connData \"\"\r\
:local connCount 0\r\
:local maxConns 200\r\
\r\
:foreach c in=[/ip firewall connection find where src-address~\"10\\.0\\.\"] do={\r\
    :if (\$connCount < \$maxConns) do={\r\
        :do {\r\
            :local src [/ip firewall connection get \$c src-address]\r\
            :local dst [/ip firewall connection get \$c dst-address]\r\
            :local origB [/ip firewall connection get \$c orig-bytes]\r\
            :local replB [/ip firewall connection get \$c repl-bytes]\r\
\r\
            :local srcIP \$src\r\
            :local colonPos [:find \$src \":\"]\r\
            :if ([:typeof \$colonPos] != \"nothing\") do={\r\
                :set srcIP [:pick \$src 0 \$colonPos]\r\
            }\r\
\r\
            :local dstIP \$dst\r\
            :local dport \"0\"\r\
            :set colonPos [:find \$dst \":\"]\r\
            :if ([:typeof \$colonPos] != \"nothing\") do={\r\
                :set dstIP [:pick \$dst 0 \$colonPos]\r\
                :set dport [:pick \$dst (\$colonPos + 1) [:len \$dst]]\r\
            }\r\
\r\
            :local isLocal 0\r\
            :if ([:pick \$dstIP 0 3] = \"10.\") do={ :set isLocal 1 }\r\
            :if ([:len \$dstIP] >= 8) do={\r\
                :if ([:pick \$dstIP 0 8] = \"192.168.\") do={ :set isLocal 1 }\r\
            }\r\
            :if ([:len \$dstIP] >= 4) do={\r\
                :if ([:pick \$dstIP 0 4] = \"172.\") do={\r\
                    :local secondOctet [:pick \$dstIP 4 [:find \$dstIP \".\" 4]]\r\
                    :if ([:tonum \$secondOctet] >= 16 and [:tonum \$secondOctet] <= 31) do={ :set isLocal 1 }\r\
                }\r\
            }\r\
            :local totalB (\$origB + \$replB)\r\
            :if (\$totalB > 10000 and \$isLocal = 0) do={\r\
                :set connData (\$connData . \$srcIP . \",\" . \$dstIP . \",\" . \$dport . \",\" . \$origB . \",\" . \$replB . \";\")\r\
                :set connCount (\$connCount + 1)\r\
            }\r\
        } on-error={}\r\
    }\r\
}\r\
\r\
:local dnsData \"\"\r\
:local dnsCount 0\r\
:local maxDns 500\r\
\r\
:foreach d in=[/ip dns cache find where type=\"A\"] do={\r\
    :if (\$dnsCount < \$maxDns) do={\r\
        :do {\r\
            :local dName [/ip dns cache get \$d name]\r\
            :local dAddr [/ip dns cache get \$d data]\r\
            :set dnsData (\$dnsData . \$dName . \">\" . \$dAddr . \";\")\r\
            :set dnsCount (\$dnsCount + 1)\r\
        } on-error={}\r\
    }\r\
}\r\
\r\
:if (\$connCount > 0) do={\r\
    :local routerName [/system identity get name]\r\
    :local sendData (\"key=\" . \$apiKey . \"&router=\" . \$routerName . \"&connections=\" . \$connData . \"&dns=\" . \$dnsData)\r\
\r\
    :do {\r\
        /tool fetch url=\$serverUrl mode=http http-method=post http-data=\$sendData http-header-field=\"Content-Type: application/x-www-form-urlencoded\" output=none\r\
        :log info (\"RANKING: Detalhes enviados - \" . \$connCount . \" conexoes, \" . \$dnsCount . \" DNS\")\r\
    } on-error={\r\
        :log error \"RANKING: Falha ao enviar detalhes para servidor local\"\r\
    }\r\
} else={\r\
    :log info \"RANKING: Nenhuma conexao relevante para enviar\"\r\
}\
"


# ============================================================
# PASSO 5 - EXECUTAR SYNC INICIAL
# ============================================================

/system script run traffic-ranking-sync-queues


# ============================================================
# PASSO 6 - AGENDAR EXECUÇÃO AUTOMÁTICA
# ============================================================
# Sync de mangle rules: a cada 30 minutos (novos dispositivos)
# Envio de tráfego:     a cada 5 minutos
# Envio de detalhes:    a cada 15 minutos (conexões + DNS)

/system scheduler add name="traffic-ranking-sync" interval=30m on-event="/system script run traffic-ranking-sync-queues" start-time=startup comment="RANKING: Sync mangle rules com DHCP leases"

/system scheduler add name="traffic-ranking-scheduler" interval=5m on-event="/system script run traffic-ranking-send" start-time=startup comment="RANKING: Envio periodico para servidor local"

/system scheduler add name="traffic-ranking-details" interval=15m on-event="/system script run traffic-ranking-send-details" start-time=startup comment="RANKING: Envio detalhes conexoes+DNS"

:log info "RANKING: Schedulers criados (sync 30min, trafego 5min, detalhes 15min)"


# ============================================================
# FINALIZAÇÃO
# ============================================================
:log warning "============================================"
:log warning "Ranking de Trafego configurado!"
:log warning "  Mangle rules por dispositivo DHCP"
:log warning "  Trafego local excluido (address-list)"
:log warning "  Sync de regras: a cada 30 min"
:log warning "  Envio trafego: a cada 5 min"
:log warning "  Envio detalhes: a cada 15 min"
:log warning "============================================"


# ============================================================
# VERIFICAÇÃO / TESTES:
# ============================================================
#
# Ver mangle rules de contagem:
#   /ip firewall mangle print where chain~"RANKING"
#   /ip firewall mangle print stats where chain~"RANKING"
#
# Ver contadores de um IP específico:
#   /ip firewall mangle print stats where src-address=10.0.2.50
#
# Forçar sync de regras (novos dispositivos):
#   /system script run traffic-ranking-sync-queues
#
# Testar envio de tráfego:
#   /system script run traffic-ranking-send
#
# Testar envio de detalhes (conexões + DNS):
#   /system script run traffic-ranking-send-details
#
# Ver log:
#   /log print where message~"RANKING"
#
# Ver schedulers:
#   /system scheduler print where comment~"RANKING"
#
# Resetar contadores:
#   /ip firewall mangle reset-counters [find where chain~"RANKING-"]
