#############################################################
# Libera acesso prioritario a internet para 10.0.0.20
# (aplicacao de monitoramento de servidores - Redix/Sentinela)
#
# Para executar no Mikrotik:
#   /import file-name=liberar_monitoramento.rsc
#
# O que este script faz:
#   1. Adiciona ACCEPT explicito no firewall filter (forward)
#      para garantir que o IP nunca seja bloqueado por regras futuras
#   2. Marca as conexoes do IP como 'conn-critico' no QoS, com
#      passthrough=no, impedindo que a regra "pesado" (>5MB)
#      sobrescreva a marca e reduza a prioridade
#   As regras sao inseridas ANTES das regras de pesado no mangle.
#############################################################

:local targetIP "10.0.0.20"

:log info "=== Liberando acesso irrestrito para $targetIP ==="
:put "=== Liberando acesso prioritario a internet para $targetIP ==="
:put ""

#------------------------------------------------------------
# [1/2] Firewall Filter: ACCEPT explicito no chain forward
#------------------------------------------------------------
:put "[1/2] Adicionando regras ACCEPT no firewall filter..."

/ip firewall filter

:if ([find comment="MONITOR: accept saida $targetIP"] = "") do={
  add chain=forward src-address=$targetIP action=accept place-before=0 \
      comment="MONITOR: accept saida $targetIP"
  :put "    OK: ACCEPT saida adicionado (src=$targetIP)"
} else={
  :put "    SKIP: regra ACCEPT saida ja existe"
}

:if ([find comment="MONITOR: accept retorno $targetIP"] = "") do={
  add chain=forward dst-address=$targetIP action=accept place-before=0 \
      comment="MONITOR: accept retorno $targetIP"
  :put "    OK: ACCEPT retorno adicionado (dst=$targetIP)"
} else={
  :put "    SKIP: regra ACCEPT retorno ja existe"
}

#------------------------------------------------------------
# [2/2] Mangle QoS: marcar como 'critico' com passthrough=no
# Inserir ANTES da regra "QOS: Conn Download pesado (>5MB)"
# O passthrough=no impede que regras subsequentes sobrescrevam
# a marca quando a conexao ultrapassar 5MB de dados.
#------------------------------------------------------------
:put "[2/2] Configurando QoS para conexoes de $targetIP..."

/ip firewall mangle

# Localizar a regra de pesado para usar como ponto de insercao
:local idxPesado [find comment="QOS: Conn Download pesado (>5MB)"]

:if ([find comment="QOS: Conn monitor $targetIP saida"] = "") do={
  :if ($idxPesado != "") do={
    add chain=forward action=mark-connection \
        new-connection-mark=conn-critico passthrough=no \
        src-address=$targetIP place-before=$idxPesado \
        comment="QOS: Conn monitor $targetIP saida"
    :put "    OK: QoS saida inserido antes da regra de pesado"
  } else={
    add chain=forward action=mark-connection \
        new-connection-mark=conn-critico passthrough=no \
        src-address=$targetIP \
        comment="QOS: Conn monitor $targetIP saida"
    :put "    OK: QoS saida inserido (regra de pesado nao encontrada)"
  }
} else={
  :put "    SKIP: regra QoS saida ja existe"
}

# Atualizar idxPesado apos a insercao anterior (indice pode ter mudado)
:set idxPesado [find comment="QOS: Conn Download pesado (>5MB)"]

:if ([find comment="QOS: Conn monitor $targetIP entrada"] = "") do={
  :if ($idxPesado != "") do={
    add chain=forward action=mark-connection \
        new-connection-mark=conn-critico passthrough=no \
        dst-address=$targetIP place-before=$idxPesado \
        comment="QOS: Conn monitor $targetIP entrada"
    :put "    OK: QoS entrada inserido antes da regra de pesado"
  } else={
    add chain=forward action=mark-connection \
        new-connection-mark=conn-critico passthrough=no \
        dst-address=$targetIP \
        comment="QOS: Conn monitor $targetIP entrada"
    :put "    OK: QoS entrada inserido (regra de pesado nao encontrada)"
  }
} else={
  :put "    SKIP: regra QoS entrada ja existe"
}

#------------------------------------------------------------
# Resumo
#------------------------------------------------------------
:put ""
:put "============================================================"
:put "  10.0.0.20 - Acesso prioritario configurado"
:put "============================================================"
:put ""
:put "  Firewall : ACCEPT explicito (saida e retorno)"
:put "  QoS      : conn-critico (prioridade 3, max 40M DN / 20M UP)"
:put "             passthrough=no - imune a reclassificacao pesado"
:put ""
:put "  VERIFICAR:"
:put "    /ip firewall filter print where comment~\"MONITOR\""
:put "    /ip firewall mangle print where comment~\"monitor\""
:put "============================================================"

:log info "=== Concluido: $targetIP com acesso irrestrito/prioritario ==="
