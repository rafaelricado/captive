const { RouterOSAPI } = require('node-routeros');

let api = null;
let apiConnected = false;

async function getApi() {
  if (api && apiConnected) return api;

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
        `=comment=${nomeCompleto}`,
        '=server=all'
      ];
      if (mac) addParams.push(`=mac-address=${mac}`);

      await conn.write('/ip/hotspot/user/add', addParams);
      console.log(`[Mikrotik] Usuário hotspot criado: ${cpf}`);
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

        // Cria novo binding
        const bindParams = [
          `=address=${ip}`,
          '=type=bypassed',
          `=comment=captive-portal:${cpf}`
        ];
        if (mac) bindParams.push(`=mac-address=${mac}`);

        await conn.write('/ip/hotspot/ip-binding/add', bindParams);
        console.log(`[Mikrotik] IP binding criado para ${ip} (${cpf})`);
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

async function removeUser(cpf) {
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
