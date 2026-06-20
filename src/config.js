require('dotenv').config();

// Thin-agent configuration. Intentionally minimal: the user essentially sets
// only RELAY_URL and WORKER_TOKEN, everything else has sane defaults.
// The proxy is taken from the standard environment variables (HTTPS_PROXY/
// HTTP_PROXY/NO_PROXY), the way curl/git/npm do — so the agent "just works"
// inside a corporate network without extra configuration.
module.exports = {
  // TestMW relay address. MUST be wss:// on 443 — custom ports are more often
  // blocked by egress firewalls. http(s) is supported for the polling fallback
  // and local debugging.
  relayUrl: process.env.RELAY_URL || 'wss://testmw.ru/relay/host',

  // Token that binds the agent to the user's account (issued in the TestMW
  // dashboard). The server uses it to know whose agent this is and routes ONLY
  // that user's tasks to it.
  token: process.env.WORKER_TOKEN || '',

  // Human-readable instance name (shown in the dashboard "online hosts" list).
  name: process.env.HOST_NAME || require('os').hostname() || 'browser-host',

  transport: {
    // Preferred transport: 'auto' (WS, falls back to polling on failure),
    // 'ws' (WebSocket only), 'polling' (long-polling right away).
    mode: process.env.TRANSPORT_MODE || 'auto',

    // How many consecutive WS failures before degrading to polling (for 'auto').
    wsFailThreshold: parseInt(process.env.WS_FAIL_THRESHOLD, 10) || 3,

    // Heartbeat: ping every N ms; if no pong arrives within pongTimeoutMs the
    // channel is considered dead and reconnects. VPNs/proxies love to silently
    // "hang" idle connections, so the heartbeat is mandatory.
    heartbeatMs: parseInt(process.env.HEARTBEAT_MS, 10) || 25000,
    pongTimeoutMs: parseInt(process.env.PONG_TIMEOUT_MS, 10) || 10000,

    // Long-polling: how long the server holds the GET request and the pause
    // between iterations when the response is empty.
    pollHoldMs: parseInt(process.env.POLL_HOLD_MS, 10) || 25000,
    pollIdleMs: parseInt(process.env.POLL_IDLE_MS, 10) || 1000,
  },

  // Local browser options. Each task launches its own launchServer (isolation,
  // just like a regular worker). headless by default; can be disabled for
  // debugging (HEADLESS=false). maxSessions is the cap on simultaneous
  // browsers on this machine.
  browser: {
    headless: process.env.HEADLESS !== 'false',
    maxSessions: parseInt(process.env.MAX_SESSIONS, 10) || 4,
    // Extra comma-separated Chromium CLI args (e.g. for CI/container).
    args: (process.env.BROWSER_ARGS || '').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // Reconnect with exponential backoff + jitter (so that on a mass disconnect
  // the agents don't hammer the relay in sync).
  backoff: {
    baseMs: parseInt(process.env.BACKOFF_BASE_MS, 10) || 1000,
    maxMs: parseInt(process.env.BACKOFF_MAX_MS, 10) || 30000,
    jitter: 0.3, // ±30%
  },

  // TLS: by default we trust the SYSTEM CA store (Node picks it up via
  // --use-system-ca / NODE_EXTRA_CA_CERTS). This matters for networks with TLS
  // inspection (a corporate MITM proxy with its own CA). We do NOT pin certs —
  // otherwise such networks would break the channel. rejectUnauthorized stays
  // true; disabling it (TLS_INSECURE=1) is for debugging only.
  tls: {
    insecure: process.env.TLS_INSECURE === '1',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};
