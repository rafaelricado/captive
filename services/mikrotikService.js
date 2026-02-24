const { RouterOSAPI } = require('node-routeros');

let api = null;
let apiConnected = false;
let connectingPromise = null; // previne múltiplas conexões simultâneas (race condition)

// Remove caracteres especiais que podem causar problemas no campo comment do RouterOS
function sanitizeComment(str) {
  return String(str).replace(/[^\w\s\u00C0-\u017E-]/g, '').trim().substring(0, 100);
}

async function getApi() {
  if (api && apiConnected) return api;

  // Se já há uma tentativa de conexão em andamento, aguarda ela terminar
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    apiConnected = false;
    api = new RouterOSAPI({
      host: process.env.MIKROTIK_HOST,
      user: process.env.MIKROTIK_USER,
      password: process.env.MIKROTIK_PASS,
      port: parseInt(process.env.MIKROTIK_PORT || '8728', 10),
      timeout: 10
    });

    try {
      await api.connect();
      apiConnected = true;
      console.log('[Mikrotik] Conectado ao RouterOS v7');
      return api;
    } catch (err) {
      console.error('[Mikrotik] Erro ao conectar:', err.message);
      api = null;
      apiConnected = false;
      throw err;
    }
  })().finally(() => {
    connectingPromise = null;
  });

  return connectingPromise;
}

async function authorizeUser(mac, ip, cpf, nomeCompleto) {
  try {
    const conn = await getApi();

    // Verifica se o usuário já existe no hotspot
    const existing = await conn.write('/ip/hotspot/user/print', [
      `?name=${cpf}`
    ]);

    if (existing.length === 0) {
      const addParams = [
        `=name=${cpf}`,
        `=comment=${sanitizeComment(nomeCompleto)}`,
        '=server=all'
      ];
      // MAC não incluído: dispositivos modernos usam MAC aleatório por rede,
      // então o vínculo seria quebrado a cada reconexão. O CPF já identifica o usuário.

      await conn.write('/ip/hotspot/user/add', addParams);
      console.log(`[Mikrotik] Usuário hotspot criado: ${cpf} (mac: ${mac || 'desconhecido'})`);
    }

    // Cria IP binding para liberar acesso imediato
    if (ip) {
      try {
        // Remove binding anterior do mesmo CPF (se existir)
        const oldBindings = await conn.write('/ip/hotspot/ip-binding/print', [
          `?comment=captive-portal:${cpf}`
        ]);
        for (const binding of oldBindings) {
          await conn.write('/ip/hotspot/ip-binding/remove', [
            `=.id=${binding['.id']}`
          ]);
        }

        // Cria novo binding por IP (sem MAC — evita quebra com MAC aleatório)
        const bindParams = [
          `=address=${ip}`,
          '=type=bypassed',
          `=comment=captive-portal:${cpf}`
        ];

        await conn.write('/ip/hotspot/ip-binding/add', bindParams);
        console.log(`[Mikrotik] IP binding criado para ${ip} mac=${mac || '?'} (${cpf})`);
      } catch (err) {
        console.warn('[Mikrotik] Aviso ao criar IP binding:', err.message);
      }
    }

    return true;
  } catch (err) {
    console.error('[Mikrotik] Erro ao autorizar usuário:', err.message);
    apiConnected = false;
    return false;
  }
}

/**
 * Remove o acesso do usuário no Mikrotik.
 *
 * @param {string} cpf - CPF do usuário (11 dígitos)
 * @param {boolean} fullDelete - Se true, remove também o usuário do hotspot (usar em exclusão por LGPD).
 *                               Se false (padrão), remove apenas o IP binding (sessão encerrada/expirada —
 *                               o usuário pode voltar a se autenticar pelo portal).
 */
async function removeUser(cpf, fullDelete = false) {
  try {
    const conn = await getApi();

    // Remove IP bindings do captive portal
    const bindings = await conn.write('/ip/hotspot/ip-binding/print', [
      `?comment=captive-portal:${cpf}`
    ]);

    for (const binding of bindings) {
      await conn.write('/ip/hotspot/ip-binding/remove', [
        `=.id=${binding['.id']}`
      ]);
    }

    // Remoção completa: remove o usuário do hotspot (exclusão por LGPD / admin)
    if (fullDelete) {
      const hotspotUsers = await conn.write('/ip/hotspot/user/print', [
        `?name=${cpf}`
      ]);
      for (const u of hotspotUsers) {
        await conn.write('/ip/hotspot/user/remove', [
          `=.id=${u['.id']}`
        ]);
      }
      console.log(`[Mikrotik] Usuário hotspot removido: ${cpf}`);
    }

    console.log(`[Mikrotik] Autorizações removidas para: ${cpf}`);
    return true;
  } catch (err) {
    console.error('[Mikrotik] Erro ao remover usuário:', err.message);
    apiConnected = false;
    return false;
  }
}

async function disconnect() {
  if (api) {
    try {
      api.disconnect();
    } catch (err) {
      // ignora erro ao fechar
    }
    api = null;
    apiConnected = false;
  }
}

module.exports = { authorizeUser, removeUser, disconnect };
