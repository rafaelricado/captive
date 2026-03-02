# ============================================================
# NETFLOW / TRAFFIC FLOW - CONFIGURAÇÃO
# Router: CCR1009-7G-1C-1S+ | RouterOS 7.20.6
# ============================================================
# Substitui o sistema de mangle rules (RANKING-UP/RANKING-DN)
# pelo Traffic Flow nativo do RouterOS 7, que envia dados de
# tráfego via UDP para o servidor local.
#
# O servidor Node.js recebe os flows em :2055 (UDP),
# acumula por IP e grava no banco a cada 5 minutos.
#
# ANTES DE APLICAR:
#   1. Ajuste $serverIp para o IP do servidor Node.js
#   2. Ajuste $lanInterface para a interface da LAN
#      (ex: bridge, bridge1, ether2)
#
# APLICAÇÃO: /import file-name=netflow_config.rsc
# ============================================================


# ============================================================
# VARIÁVEIS — EDITE AQUI ANTES DE IMPORTAR
# ============================================================
:local serverIp    "10.0.0.56"
:local serverPort  2055
:local lanInterface "bridge"


# ============================================================
# PASSO 1 - LIMPEZA DA CONFIGURAÇÃO ANTERIOR (MANGLE / RANKING)
# ============================================================

:log info "NETFLOW: Removendo configuracao de mangle rules anterior..."

:do { /system scheduler remove [find name="traffic-ranking-scheduler"] } on-error={}
:do { /system scheduler remove [find name="traffic-ranking-sync"] } on-error={}
:do { /system scheduler remove [find name="traffic-ranking-details"] } on-error={}
:do { /system script remove [find name="traffic-ranking-send"] } on-error={}
:do { /system script remove [find name="traffic-ranking-sync-queues"] } on-error={}
:do { /system script remove [find name="traffic-ranking-send-details"] } on-error={}
:do {
    :foreach r in=[/ip firewall mangle find where comment~"RANKING"] do={
        /ip firewall mangle remove $r
    }
} on-error={}
:do { /ip firewall address-list remove [find where list="RANKING-local"] } on-error={}
:do {
    :foreach q in=[/queue simple find where comment~"RANKING:"] do={
        /queue simple remove $q
    }
} on-error={}
:do { :global rankPrevE5rx; :set rankPrevE5rx } on-error={}
:do { :global rankPrevE5tx; :set rankPrevE5tx } on-error={}
:do { :global rankPrevVlrx; :set rankPrevVlrx } on-error={}
:do { :global rankPrevVltx; :set rankPrevVltx } on-error={}

:log info "NETFLOW: Limpeza concluida"


# ============================================================
# PASSO 2 - REMOVER TARGET NETFLOW ANTERIOR (SE EXISTIR)
# ============================================================

:do {
    :foreach t in=[/ip traffic-flow target find where dst-address=$serverIp] do={
        /ip traffic-flow target remove $t
    }
} on-error={}


# ============================================================
# PASSO 3 - CONFIGURAR TRAFFIC FLOW
# ============================================================
# active-flow-timeout:   exporta flows ativos a cada 1 minuto
# inactive-flow-timeout: exporta flows inativos após 15 segundos

/ip traffic-flow set \
    enabled=yes \
    active-flow-timeout=1m \
    inactive-flow-timeout=15s \
    interfaces=$lanInterface

:log info ("NETFLOW: Traffic Flow habilitado na interface: " . $lanInterface)


# ============================================================
# PASSO 4 - ADICIONAR TARGET (SERVIDOR NODE.JS)
# ============================================================

/ip traffic-flow target add \
    dst-address=$serverIp \
    port=$serverPort \
    version=9

:log info ("NETFLOW: Target configurado -> " . $serverIp . ":" . $serverPort . " (Netflow v9)")


# ============================================================
# FINALIZAÇÃO
# ============================================================
:log warning "============================================"
:log warning "Traffic Flow (Netflow v9) configurado!"
:log warning ("  Interface  : " . $lanInterface)
:log warning ("  Servidor   : " . $serverIp . ":" . $serverPort)
:log warning "  Protocolo  : Netflow v9 (UDP)"
:log warning "  Flow ativo : exportado a cada 1 min"
:log warning "  Flow inativo: exportado apos 15s"
:log warning "============================================"


# ============================================================
# VERIFICAÇÃO:
# ============================================================
#
# Confirmar configuração:
#   /ip traffic-flow print
#   /ip traffic-flow target print
#
# Ver estatísticas de flows exportados:
#   /ip traffic-flow target print stats
#
# Ver log:
#   /log print where message~"NETFLOW"
#
# Confirmar que mangle rules foram removidas:
#   /ip firewall mangle print where comment~"RANKING"
#   /system scheduler print where comment~"RANKING"
