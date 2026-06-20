const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('./logger');

// Parsing of the standard proxy environment variables. We support both cases
// (HTTPS_PROXY and https_proxy) — different tools write them differently.
function envAny(...names) {
  for (const n of names) {
    const v = process.env[n] || process.env[n.toLowerCase()];
    if (v) return v;
  }
  return '';
}

// NO_PROXY check: a comma-separated list of hosts/domains. We support suffix
// matching (".internal" / "internal" → host.internal) and "*".
function isBypassed(hostname) {
  const noProxy = envAny('NO_PROXY');
  if (!noProxy) return false;
  const host = String(hostname || '').toLowerCase();
  for (let rule of noProxy.split(',')) {
    rule = rule.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;
    const bare = rule.replace(/^\./, '');
    if (host === bare || host.endsWith('.' + bare)) return true;
  }
  return false;
}

// Return { proxyUrl, agent } for the target URL, or { } if no proxy is needed.
// agent is an HttpsProxyAgent instance understood by both ws and axios (via
// httpsAgent). One object for both transports so the behaviour is identical.
function getProxyAgent(targetUrl) {
  let hostname;
  try {
    hostname = new URL(targetUrl.replace(/^ws/, 'http')).hostname;
  } catch {
    hostname = '';
  }
  if (isBypassed(hostname)) return {};

  const proxyUrl = envAny('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY');
  if (!proxyUrl) return {};

  logger.info(`Using proxy: ${proxyUrl} (for ${hostname})`);
  return { proxyUrl, agent: new HttpsProxyAgent(proxyUrl) };
}

module.exports = { getProxyAgent, isBypassed };
