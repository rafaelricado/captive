const fs   = require('fs');
const path = require('path');
const { Setting } = require('../../models');
const logger = require('../../utils/logger');
const { audit } = require('../../utils/auditLogger');
const settingsCache = require('../../utils/settingsCache');

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const URL_RE       = /^https?:\/\/.+/;

function isPrivateUrl(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) return true;
    if (/^10\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    return false;
  } catch (_) { return true; }
}

async function fetchAllSettings() {
  const [
    orgName, orgLogo, sessionDuration, bgColor1, bgColor2, alertWebhookUrl, mikrotikDataKey,
    securityWhitelistRaw, securityAnomalyWhitelistRaw, bruteForceThreshold, portScanThreshold,
    registerThreshold, dnsThreshold, anomalyStddev
  ] = await Promise.all([
    Setting.get('organization_name', 'Captive Portal'),
    Setting.get('organization_logo', ''),
    Setting.getSessionDuration(),
    Setting.get('portal_bg_color_1', '#0d4e8b'),
    Setting.get('portal_bg_color_2', '#1a7bc4'),
    Setting.get('alert_webhook_url', ''),
    Setting.get('mikrotik_data_key', ''),
    Setting.get('security_ip_whitelist', '[]'),
    Setting.get('security_anomaly_ip_whitelist', '[]'),
    Setting.get('security_brute_force_threshold', '5'),
    Setting.get('security_port_scan_threshold', '20'),
    Setting.get('security_register_threshold', '5'),
    Setting.get('security_dns_threshold', '50'),
    Setting.get('security_anomaly_stddev', '3')
  ]);

  let securityWhitelist = '';
  try {
    const arr = JSON.parse(securityWhitelistRaw);
    if (Array.isArray(arr)) securityWhitelist = arr.join('\n');
  } catch (_) {}

  let securityAnomalyWhitelist = '';
  try {
    const arr = JSON.parse(securityAnomalyWhitelistRaw);
    if (Array.isArray(arr)) securityAnomalyWhitelist = arr.join('\n');
  } catch (_) {}

  return {
    orgName, orgLogo, sessionDuration, bgColor1, bgColor2, alertWebhookUrl, mikrotikDataKey,
    securityWhitelist, securityAnomalyWhitelist, bruteForceThreshold, portScanThreshold,
    registerThreshold, dnsThreshold, anomalyStddev
  };
}

exports.showSettings = async (req, res) => {
  try {
    const s = await fetchAllSettings();
    res.render('admin/settings', { ...s, page: 'settings', success: null, error: null });
  } catch (err) {
    logger.error(`[Admin] Erro ao carregar configurações: ${err.message}`);
    res.status(500).send('Erro interno.');
  }
};

exports.saveSettings = async (req, res) => {
  const renderSettings = async (success, error) => {
    const s = await fetchAllSettings();
    res.render('admin/settings', { ...s, page: 'settings', success, error });
  };

  if (req.uploadError) {
    return await renderSettings(null, req.uploadError);
  }

  try {
    const {
      organization_name, session_duration_hours,
      remove_logo, portal_bg_color_1, portal_bg_color_2,
      alert_webhook_url, mikrotik_data_key
    } = req.body;

    if (organization_name && organization_name.trim()) {
      await Setting.set('organization_name', organization_name.trim());
    }

    const hours = parseInt(session_duration_hours, 10);
    if (isNaN(hours) || hours < 1 || hours > 720) {
      return await renderSettings(null, 'Duração da sessão inválida. Informe um valor entre 1 e 720 horas.');
    }
    await Setting.set('session_duration_hours', String(hours));

    if (!HEX_COLOR_RE.test(portal_bg_color_1) || !HEX_COLOR_RE.test(portal_bg_color_2)) {
      return await renderSettings(null, 'Cor inválida. Use o seletor de cor ou o formato #RRGGBB.');
    }
    await Setting.set('portal_bg_color_1', portal_bg_color_1);
    await Setting.set('portal_bg_color_2', portal_bg_color_2);

    const webhookUrl = (alert_webhook_url || '').trim();
    if (webhookUrl) {
      if (!URL_RE.test(webhookUrl)) {
        return await renderSettings(null, 'URL do webhook inválida. Use http:// ou https://');
      }
      if (isPrivateUrl(webhookUrl)) {
        return await renderSettings(null, 'URL do webhook não pode apontar para endereços internos ou localhost.');
      }
    }
    await Setting.set('alert_webhook_url', webhookUrl);

    if (remove_logo === '1') {
      const oldLogo = await Setting.get('organization_logo', '');
      if (oldLogo) {
        const oldPath = path.join(__dirname, '../../public', oldLogo);
        try { fs.unlinkSync(oldPath); } catch (_) { /* arquivo já removido */ }
      }
      await Setting.set('organization_logo', '');
    } else if (req.file) {
      const oldLogo = await Setting.get('organization_logo', '');
      if (oldLogo) {
        const oldPath = path.join(__dirname, '../../public', oldLogo);
        try { fs.unlinkSync(oldPath); } catch (_) { /* arquivo já removido */ }
      }
      await Setting.set('organization_logo', `/uploads/logo/${req.file.filename}`);
    }

    await Setting.set('mikrotik_data_key', (mikrotik_data_key || '').trim());

    // ── Configurações de segurança ──
    const {
      security_ip_whitelist, security_anomaly_ip_whitelist,
      security_brute_force_threshold, security_port_scan_threshold,
      security_register_threshold, security_dns_threshold, security_anomaly_stddev
    } = req.body;

    const IP_RE = /^[\d.a-fA-F:]{1,45}$/;
    function parseWhitelist(raw, label) {
      const lines   = (raw || '').split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
      const invalid = lines.filter(ip => !IP_RE.test(ip));
      if (invalid.length > 0) throw new Error(`IP(s) inválido(s) na ${label}: ${invalid.slice(0, 3).join(', ')}`);
      if (lines.length > 100) throw new Error(`${label} não pode ter mais de 100 IPs.`);
      return lines;
    }
    let whitelistLines, anomalyWhitelistLines;
    try {
      whitelistLines        = parseWhitelist(security_ip_whitelist,         'whitelist global');
      anomalyWhitelistLines = parseWhitelist(security_anomaly_ip_whitelist, 'whitelist de anomalia');
    } catch (e) {
      return await renderSettings(null, e.message);
    }
    await Setting.set('security_ip_whitelist',         JSON.stringify(whitelistLines));
    await Setting.set('security_anomaly_ip_whitelist', JSON.stringify(anomalyWhitelistLines));

    const thresholds = [
      ['security_brute_force_threshold', security_brute_force_threshold, 1, 10000],
      ['security_port_scan_threshold',   security_port_scan_threshold,   1, 10000],
      ['security_register_threshold',    security_register_threshold,    1, 10000],
      ['security_dns_threshold',         security_dns_threshold,         1, 10000]
    ];
    for (const [key, val, min, max] of thresholds) {
      const n = parseInt(val, 10);
      if (isNaN(n) || n < min || n > max) {
        return await renderSettings(null, `Limiar inválido para ${key}. Use um valor entre ${min} e ${max}.`);
      }
      await Setting.set(key, String(n));
    }

    const stddev = parseFloat(security_anomaly_stddev);
    if (isNaN(stddev) || stddev < 1 || stddev > 10) {
      return await renderSettings(null, 'Fator de desvio padrão deve ser entre 1.0 e 10.0.');
    }
    await Setting.set('security_anomaly_stddev', String(stddev));

    settingsCache.invalidate('org_settings');

    logger.info('[Admin] Configurações atualizadas');
    audit('settings.update', { ip: req.ip });
    await renderSettings('Configurações salvas com sucesso.', null);
  } catch (err) {
    logger.error(`[Admin] Erro ao salvar configurações: ${err.message}`);
    await renderSettings(null, 'Erro ao salvar as configurações. Tente novamente.');
  }
};

exports.testWebhook = async (req, res) => {
  try {
    const webhookUrl = await Setting.get('alert_webhook_url', '');
    if (!webhookUrl) return res.json({ ok: false, error: 'Nenhuma URL de webhook configurada.' });
    if (!URL_RE.test(webhookUrl) || isPrivateUrl(webhookUrl)) {
      return res.json({ ok: false, error: 'URL de webhook inválida ou aponta para endereço interno.' });
    }
    const payload = JSON.stringify({
      event: 'test',
      message: 'Teste de webhook do Captive Portal',
      timestamp: new Date().toISOString()
    });
    const u   = new URL(webhookUrl);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const httpReq = mod.request(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000
      }, resolve);
      httpReq.on('error', reject);
      httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('Timeout')); });
      httpReq.write(payload);
      httpReq.end();
    });
    logger.info('[Admin] Teste de webhook enviado com sucesso.');
    res.json({ ok: true });
  } catch (err) {
    logger.warn(`[Admin] Falha no teste de webhook: ${err.message}`);
    res.json({ ok: false, error: err.message });
  }
};

exports.downloadTrafficScript = async (req, res) => {
  try {
    const rscPath = path.join(__dirname, '../../traffic_ranking.rsc');
    if (!fs.existsSync(rscPath)) {
      return res.status(404).send('Script traffic_ranking.rsc não encontrado no servidor.');
    }

    const apiKey    = await Setting.get('mikrotik_data_key', '');
    const serverIp  = process.env.CAPTIVE_SERVER_IP || '10.0.0.56';
    const port      = process.env.PORT || '3000';
    const serverUrl = `http://${serverIp}:${port}/api/mikrotik/traffic`;
    const detailUrl = `http://${serverIp}:${port}/api/mikrotik/details`;

    let content = fs.readFileSync(rscPath, 'utf8');

    content = content.replace(
      /("http:\/\/[\d.]+:\d+\/api\/mikrotik\/traffic")/g,
      `"${serverUrl}"`
    );
    content = content.replace(
      /("http:\/\/[\d.]+:\d+\/api\/mikrotik\/details")/g,
      `"${detailUrl}"`
    );
    if (apiKey) {
      content = content.replace(
        /:local apiKey "[^"]*"/g,
        `:local apiKey "${apiKey}"`
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    content = content.replace(/^# Gerado em: .+$/m, `# Gerado em: ${today} (via painel admin)`);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="traffic_ranking.rsc"');
    logger.info(`[Admin] Download do script RSC gerado (${req.ip})`);
    audit('settings.download_rsc', { ip: req.ip });
    res.send(content);
  } catch (err) {
    logger.error(`[Admin] Erro ao gerar script RSC: ${err.message}`);
    res.status(500).send('Erro ao gerar o script.');
  }
};
