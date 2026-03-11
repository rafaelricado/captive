# Análise Técnica — Captive Portal
**Data:** 2026-03-11
**Versão analisada:** branch `master` (pós-modularização hospital + network)

---

## Índice
1. [Referências de módulo quebradas (ativos)](#1-referências-de-módulo-quebradas-ativos)
2. [Código morto pós-modularização](#2-código-morto-pós-modularização)
3. [Bugs de segurança](#3-bugs-de-segurança)
4. [Bugs funcionais](#4-bugs-funcionais)
5. [Tabela resumo](#5-tabela-resumo)

---

## 1. Referências de módulo quebradas (ativos)

Estes problemas afetam código que **está em execução**. Após a migração dos serviços para `modules/network/` e `modules/hospital/`, vários arquivos ainda apontam para os caminhos antigos em `services/`.

### 1.1 — `server.js:29` usa `services/pingService` antigo

```js
// server.js:29 — ERRADO
const { pingAllAccessPoints } = require('./services/pingService');
// Deveria ser:
const { pingAllAccessPoints } = require('./modules/network/services/pingService');
```

**Impacto:** O cron de ping de APs (a cada 5 min) carrega a cópia antiga do serviço em vez do módulo correto. Qualquer atualização feita em `modules/network/services/pingService.js` não é refletida no cron.

**Severidade:** Alto

---

### 1.2 — `controllers/apiController.js:5` usa `services/mikrotikService` antigo

```js
// controllers/apiController.js:5 — ERRADO
const mikrotikService = require('../services/mikrotikService');
// Deveria ser:
const mikrotikService = require('../modules/network/services/mikrotikService');
```

**Impacto:** O fluxo de registro do portal (autenticação de novos usuários no hotspot) usa a cópia antiga. Resultado: o `apiController` e `modules/network/controllers/managedIpsController` operam instâncias separadas do serviço Mikrotik — cada uma com seu próprio estado de conexão (`api`, `apiConnected`). Isso duplica conexões e pode levar a comportamento inconsistente.

**Severidade:** Alto

---

### 1.3 — `controllers/apiController.js:7` usa `services/tasyService` antigo

```js
// controllers/apiController.js:7 — ERRADO
const { lookupPessoaFisica } = require('../services/tasyService');
// Deveria ser:
const { lookupPessoaFisica } = require('../modules/hospital/services/tasyService');
```

**Impacto:** O portal de registro usa `lookupPessoaFisica` da cópia antiga do serviço Tasy/Oracle. Se o serviço do módulo hospitalar for atualizado, o portal não recebe a atualização.

**Severidade:** Alto

---

### 1.4 — `controllers/admin/usersController.js:3` e `sessionsController.js:3` usam `services/mikrotikService` antigo

```js
// controllers/admin/usersController.js:3 — ERRADO
const mikrotikService = require('../../services/mikrotikService');
// controllers/admin/sessionsController.js:3 — ERRADO
const mikrotikService = require('../../services/mikrotikService');
// Ambos deveriam ser:
const mikrotikService = require('../../modules/network/services/mikrotikService');
```

**Impacto:** Operações de encerramento de sessão e exclusão de usuário (`removeUser`) chamam a instância antiga do serviço, que tem estado de conexão independente da instância usada pelo resto do sistema.

**Severidade:** Alto

---

## 2. Código morto pós-modularização

Estes arquivos **não causam bugs ativos** mas criam confusão, aumentam a superfície de manutenção e podem introduzir bugs futuros se um desenvolvedor os editar pensando que estão em uso.

### 2.1 — `routes/mikrotik.js` não é mais montado

`server.js` agora usa `modules/network/dataRoutes` para montar em `/api/mikrotik`. O arquivo `routes/mikrotik.js` ainda existe mas nunca é `require()`-ado. Também referencia `controllers/mikrotikDataController` (caminho antigo).

**Arquivo para remover:** `routes/mikrotik.js`

---

### 2.2 — Controllers em `controllers/admin/` não usados por nenhuma rota

Após a modularização, `routes/admin.js` não importa mais os seguintes controllers. Eles existem como cópias obsoletas:

| Arquivo | Movido para |
|---|---|
| `controllers/admin/accessPointsController.js` | `modules/network/controllers/` |
| `controllers/admin/networkController.js` | `modules/network/controllers/` |
| `controllers/admin/devicesController.js` | `modules/network/controllers/` |
| `controllers/admin/managedIpsController.js` | `modules/network/controllers/` |
| `controllers/admin/tasyController.js` | `modules/hospital/controllers/` |
| `controllers/admin/tasyProtocoloController.js` | `modules/hospital/controllers/` |
| `controllers/admin/tasyAlertaController.js` | `modules/hospital/controllers/` |
| `controllers/admin/tasyOcupacaoController.js` | `modules/hospital/controllers/` |

> **Nota:** `dashboardController.js`, `usersController.js`, `sessionsController.js`, `settingsController.js`, `securityController.js`, `authController.js` e `helpers.js` **continuam em uso** e não devem ser removidos.

---

### 2.3 — `controllers/mikrotikDataController.js` (raiz) é código morto

Este arquivo foi copiado para `modules/network/controllers/mikrotikDataController.js`. O original em `controllers/mikrotikDataController.js` não é mais referenciado por nenhuma rota ativa.

**Arquivo para remover:** `controllers/mikrotikDataController.js`

---

### 2.4 — Serviços originais em `services/` têm cópias em `modules/`

Os arquivos abaixo ainda existem em `services/` mas foram copiados para `modules/network/services/`. Enquanto code ativo (itens 1.1–1.4) ainda os referencia, a intenção é que sejam substituídos pelas versões modularizadas.

| Original (a remover após correção 1.x) | Módulo correto |
|---|---|
| `services/mikrotikService.js` | `modules/network/services/mikrotikService.js` |
| `services/pingService.js` | `modules/network/services/pingService.js` |
| `services/netflowCollector.js` | `modules/network/services/netflowCollector.js` |
| `services/tasyService.js` | `modules/hospital/services/tasyService.js` |

---

## 3. Bugs de segurança

### 3.1 — Cookie `sameSite: 'lax'` — deveria ser `'strict'`

**Arquivo:** `server.js:97`

```js
// Atual — INCORRETO
sameSite: 'lax',
// Correto
sameSite: 'strict',
```

`'lax'` permite que cookies de sessão sejam enviados em requisições cross-site iniciadas por navegação de top-level (ex.: clique em link). `'strict'` não envia o cookie em nenhum contexto cross-site, prevenindo CSRF de forma mais robusta.

**Severidade:** Médio

---

### 3.2 — `SESSION_SECRET` sem validação de comprimento mínimo

**Arquivo:** `server.js:10-19`

O código verifica apenas se a variável existe, não se tem comprimento suficiente para ser criptograficamente segura:

```js
const missing = requiredEnvVars.filter(v => !process.env[v]);
// Falta validação:
// if (process.env.SESSION_SECRET.length < 32) { ... process.exit(1) }
```

Um `SESSION_SECRET` curto (ex.: `"abc"`) é facilmente quebrado por força bruta.

**Severidade:** Médio

---

### 3.3 — `isPrivateUrl()` síncrona — sem proteção contra DNS rebinding

**Arquivo:** `controllers/admin/settingsController.js:20-29`

A função verifica apenas se o hostname textual é privado. Um atacante pode registrar um domínio público (`attacker.com`) que inicialmente resolve para IP público, mas depois é alterado via DNS TTL baixo para resolver `192.168.x.x` (DNS rebinding). A função não resolve o DNS em runtime.

```js
// Atual — verifica apenas string, não resolve DNS
function isPrivateUrl(urlStr) {
  const { hostname } = new URL(urlStr);
  if (/^10\./.test(hostname)) return true;
  // ...não resolve attacker.com → 192.168.x.x
}
```

A correção exige tornar a função `async` e usar `dns.lookup()` para validar o IP resolvido.

**Severidade:** Alto

---

## 4. Bugs funcionais

### 4.1 — Race condition em `authorizeUser`: ausência de `withCpfLock()`

**Arquivos:** `services/mikrotikService.js`, `modules/network/services/mikrotikService.js`

Se dois requests chegarem simultaneamente para o mesmo CPF (ex.: duplo clique no botão de registro), ambos executam `authorizeUser()` em paralelo. As operações de "verificar se usuário existe → criar usuário" e "remover binding antigo → criar novo binding" não são atômicas na API do RouterOS. Resultado: múltiplos bindings para o mesmo CPF, ou usuário criado duas vezes.

A correção é um lock por CPF via `Map` de Promises:

```js
const cpfLocks = new Map();
async function withCpfLock(cpf, fn) {
  const prev = cpfLocks.get(cpf) || Promise.resolve();
  const next = prev.then(fn).finally(() => {
    if (cpfLocks.get(cpf) === next) cpfLocks.delete(cpf);
  });
  cpfLocks.set(cpf, next);
  return next;
}
```

**Severidade:** Alto

---

### 4.2 — Ausência de transação no registro de usuário (`apiController.js`)

**Arquivo:** `controllers/apiController.js`

As operações `User.create()` e `Session.create()` (e a chamada ao Mikrotik) são executadas de forma independente, sem `sequelize.transaction()`. Se `Session.create()` falhar após `User.create()` ter sucesso, o banco fica com um usuário sem sessão — estado inconsistente.

**Severidade:** Alto

---

### 4.3 — Ausência de normalização de MAC address em `mikrotikDataController`

**Arquivo:** `controllers/mikrotikDataController.js` e `modules/network/controllers/mikrotikDataController.js`

O código aceita apenas o formato `AA:BB:CC:DD:EE:FF` (com colons). MACs com outros formatos comuns — `AA-BB-CC-DD-EE-FF` (Windows), `aabb.ccdd.eeff` (Cisco), ou sem separadores — são descartados silenciosamente.

```js
// Aceita apenas este formato:
const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
```

**Impacto:** Dispositivos enviando MAC em formato não-padrão não terão histórico de rastreamento no banco.

**Severidade:** Médio

---

### 4.4 — Paginação sem limite máximo de `page`

**Arquivos e linhas:**

| Arquivo | Linha |
|---|---|
| `controllers/admin/usersController.js` | 10 |
| `controllers/admin/sessionsController.js` | 10 |
| `modules/network/controllers/devicesController.js` | 9 |
| `modules/network/controllers/managedIpsController.js` | 11 |
| `modules/network/controllers/networkController.js` | 216 (DNS) |

Todos usam `Math.max(0, parseInt(...))` mas sem limite superior. Uma requisição com `?page=999999999` faz o banco calcular `offset = 999999999 * PAGE_SIZE`, potencialmente causando DoS.

```js
// Atual — sem limite máximo
const page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
// Correto
const page = Math.min(10000, Math.max(0, parseInt(req.query.page || '0', 10) || 0));
```

**Severidade:** Médio

---

## 5. Tabela resumo

| # | Arquivo | Severidade | Tipo | Descrição |
|---|---|---|---|---|
| 1.1 | `server.js:29` | 🔴 Alto | Bug ativo | `services/pingService` ao invés de `modules/network/services/pingService` |
| 1.2 | `controllers/apiController.js:5` | 🔴 Alto | Bug ativo | `services/mikrotikService` ao invés de módulo; instâncias duplicadas |
| 1.3 | `controllers/apiController.js:7` | 🔴 Alto | Bug ativo | `services/tasyService` ao invés de `modules/hospital/services/tasyService` |
| 1.4 | `controllers/admin/usersController.js:3`, `sessionsController.js:3` | 🔴 Alto | Bug ativo | `services/mikrotikService` ao invés de módulo |
| 2.1 | `routes/mikrotik.js` | ⚪ Info | Código morto | Não é mais montado; referencía controller antigo |
| 2.2 | `controllers/admin/accessPointsController.js` e outros 7 | ⚪ Info | Código morto | Controllers fora de uso após modularização |
| 2.3 | `controllers/mikrotikDataController.js` | ⚪ Info | Código morto | Substituído por `modules/network/controllers/` |
| 2.4 | `services/mikrotikService.js` e outros 3 | ⚪ Info | Código morto | Serviços originais a remover após corrigir 1.x |
| 3.1 | `server.js:97` | 🟡 Médio | Segurança | Cookie `sameSite: 'lax'` deveria ser `'strict'` |
| 3.2 | `server.js:10-19` | 🟡 Médio | Segurança | `SESSION_SECRET` sem validação de comprimento mínimo (≥32) |
| 3.3 | `settingsController.js:20` | 🔴 Alto | Segurança | `isPrivateUrl()` síncrona; sem proteção a DNS rebinding |
| 4.1 | `services/mikrotikService.js` (ambos) | 🔴 Alto | Bug funcional | Race condition por CPF; ausência de `withCpfLock()` |
| 4.2 | `controllers/apiController.js` | 🔴 Alto | Bug funcional | `User.create` + `Session.create` sem `sequelize.transaction()` |
| 4.3 | `mikrotikDataController.js` (ambos) | 🟡 Médio | Bug funcional | MAC aceito apenas com colons; outros formatos descartados |
| 4.4 | 5 controllers (ver §4.4) | 🟡 Médio | Bug funcional | Paginação sem `Math.min(10000, ...)` — possível DoS |

---

### Legenda de severidade
| Cor | Significado |
|---|---|
| 🔴 Alto | Causa bugs em produção ou é exploração de segurança relevante |
| 🟡 Médio | Risco real mas com vetor de exploração restrito |
| ⚪ Info | Sem impacto imediato; aumenta débito técnico |
