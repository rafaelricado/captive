# ============================================================
# RANKING DE TRÁFEGO - REMOÇÃO COMPLETA
# Router: CCR1009-7G-1C-1S+ | RouterOS 7.20.6
# ============================================================
# Remove toda a configuração criada pelo traffic_ranking.rsc:
#   - Schedulers de coleta e sync
#   - Scripts de coleta, sync e detalhes
#   - Mangle rules (jump rules + chains RANKING-UP / RANKING-DN)
#   - Address-list RANKING-local
#   - Filas simples marcadas como RANKING (se houver)
#   - Variáveis globais de delta de interface
#
# APLICAÇÃO: /import file-name=traffic_ranking_remove.rsc
# ============================================================

:log warning "RANKING: Iniciando remocao completa..."

# ------------------------------------------------------------
# 1. Schedulers
# ------------------------------------------------------------
:do { /system scheduler remove [find name="traffic-ranking-scheduler"] } on-error={}
:do { /system scheduler remove [find name="traffic-ranking-sync"] } on-error={}
:do { /system scheduler remove [find name="traffic-ranking-details"] } on-error={}
:log info "RANKING: Schedulers removidos"

# ------------------------------------------------------------
# 2. Scripts
# ------------------------------------------------------------
:do { /system script remove [find name="traffic-ranking-send"] } on-error={}
:do { /system script remove [find name="traffic-ranking-sync-queues"] } on-error={}
:do { /system script remove [find name="traffic-ranking-send-details"] } on-error={}
:log info "RANKING: Scripts removidos"

# ------------------------------------------------------------
# 3. Mangle rules (chains RANKING-UP e RANKING-DN + jump rules)
# ------------------------------------------------------------
:do {
    :foreach r in=[/ip firewall mangle find where comment~"RANKING"] do={
        /ip firewall mangle remove $r
    }
} on-error={}
:log info "RANKING: Mangle rules removidas"

# ------------------------------------------------------------
# 4. Address-list RANKING-local
# ------------------------------------------------------------
:do { /ip firewall address-list remove [find where list="RANKING-local"] } on-error={}
:log info "RANKING: Address-list RANKING-local removida"

# ------------------------------------------------------------
# 5. Filas simples (segurança — caso existam do cleanup anterior)
# ------------------------------------------------------------
:do {
    :foreach q in=[/queue simple find where comment~"RANKING:"] do={
        /queue simple remove $q
    }
} on-error={}
:log info "RANKING: Filas simples (RANKING) removidas"

# ------------------------------------------------------------
# 6. Variáveis globais de delta de interface
# ------------------------------------------------------------
:do { :global rankPrevE5rx; :set rankPrevE5rx } on-error={}
:do { :global rankPrevE5tx; :set rankPrevE5tx } on-error={}
:do { :global rankPrevVlrx; :set rankPrevVlrx } on-error={}
:do { :global rankPrevVltx; :set rankPrevVltx } on-error={}
:log info "RANKING: Variaveis globais limpas"

# ------------------------------------------------------------
# Conclusão
# ------------------------------------------------------------
:log warning "============================================"
:log warning "RANKING: Remocao concluida com sucesso!"
:log warning "  Schedulers : removidos"
:log warning "  Scripts    : removidos"
:log warning "  Mangle     : removidas (jumps + chains)"
:log warning "  Address-list: removida"
:log warning "  Variaveis  : limpas"
:log warning "============================================"

# ------------------------------------------------------------
# VERIFICAÇÃO PÓS-REMOÇÃO:
# ------------------------------------------------------------
#
# Confirmar que não restou nada:
#   /system scheduler print where comment~"RANKING"
#   /system script print where name~"traffic-ranking"
#   /ip firewall mangle print where comment~"RANKING"
#   /ip firewall address-list print where list="RANKING-local"
#   /log print where message~"RANKING"
