const EventEmitter = require('events');
const WebSocket = require('ws');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');
const { getProxyAgent } = require('./proxy');

// Common transport contract (subclasses emit these events):
//   'open'              — channel established
//   'message' (obj)     — a message arrived from the relay (already parsed JSON)
//   'close'  (reason)   — channel closed (triggers reconnect one level up)
//   'error'  (err)      — error (diagnostic; a close will follow separately)
// The send(obj) method serializes and sends. connect() resolves on 'open'.

// ── WebSocket transport (primary path) ───────────────────────────────────
// Outbound WSS on 443 → passes through VPN/firewall as long as plain HTTPS is
// allowed. Proxy and system CA are picked up automatically.
class WsTransport extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.alive = false;
    this._hbTimer = null;
    this._pongTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const { agent } = getProxyAgent(config.relayUrl);
      const opts = {
        agent, // HttpsProxyAgent | undefined — ws handles both correctly
        rejectUnauthorized: !config.tls.insecure,
        headers: {
          authorization: `Bearer ${config.token}`,
          'x-host-name': config.name,
        },
        handshakeTimeout: 15000,
      };
      let settled = false;
      const ws = new WebSocket(config.relayUrl, opts);
      this.ws = ws;

      ws.on('open', () => {
        settled = true;
        this.alive = true;
        this._startHeartbeat();
        logger.info('WS channel established');
        this.emit('open');
        resolve();
      });
      ws.on('message', (data) => {
        let obj;
        try { obj = JSON.parse(data.toString()); } catch { return; }
        if (obj && obj.type === '__pong') { this._onPong(); return; }
        this.emit('message', obj);
      });
      ws.on('pong', () => this._onPong());
      ws.on('error', (err) => {
        this.emit('error', err);
        if (!settled) { settled = true; reject(err); }
      });
      ws.on('close', (code, reason) => {
        this._stopHeartbeat();
        this.alive = false;
        this.emit('close', `ws closed ${code} ${reason || ''}`.trim());
        if (!settled) { settled = true; reject(new Error(`ws closed before open: ${code}`)); }
      });
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._hbTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // Protocol ping + explicit app-level ping message: some proxies do not
      // forward control frames, so we duplicate it with a JSON ping.
      try { this.ws.ping(); } catch { /* no-op */ }
      try { this.ws.send(JSON.stringify({ type: '__ping' })); } catch { /* no-op */ }
      this._pongTimer = setTimeout(() => {
        logger.warn('Heartbeat: no pong received — closing the dead channel');
        try { this.ws.terminate(); } catch { /* no-op */ }
      }, config.transport.pongTimeoutMs);
    }, config.transport.heartbeatMs);
  }

  _onPong() {
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
  }

  _stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WS is not open');
    }
    this.ws.send(JSON.stringify(obj));
  }

  close() {
    this._stopHeartbeat();
    if (this.ws) { try { this.ws.close(); } catch { /* no-op */ } this.ws = null; }
  }
}

// ── Long-polling transport (fallback) ────────────────────────────────────
// For the case when DPI/proxy blocks WebSocket but lets plain HTTPS through.
// Bidirectional-channel semantics over two relay endpoints:
//   GET  {base}/poll  — the server holds the request until a message or pollHoldMs
//   POST {base}/send  — the agent sends a message
// Both go to the same host/port 443, so they pass where the WS handshake did not.
class PollingTransport extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.base = config.relayUrl.replace(/^ws/, 'http').replace(/\/$/, '');
    const { agent } = getProxyAgent(config.relayUrl);
    this.http = axios.create({
      baseURL: this.base,
      httpsAgent: agent,
      proxy: false, // proxy is set via agent, disable axios' own auto-proxy
      headers: {
        authorization: `Bearer ${config.token}`,
        'x-host-name': config.name,
      },
      // Hold the GET a bit longer than the server's hold so the client doesn't
      // tear it down first.
      timeout: config.transport.pollHoldMs + 10000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
  }

  async connect() {
    this.running = true;
    // "Opening" the channel for polling means a successful first long-poll.
    // This both confirms the HTTPS path to the relay is alive and immediately
    // drains buffered messages.
    this._loop();
    logger.info('Polling channel started');
    this.emit('open');
  }

  async _loop() {
    while (this.running) {
      try {
        const res = await this.http.get('/poll', {
          params: { hold: config.transport.pollHoldMs },
        });
        if (res.status === 401 || res.status === 403) {
          this.emit('close', `polling auth failed ${res.status}`);
          return;
        }
        const msgs = Array.isArray(res.data?.messages) ? res.data.messages : [];
        for (const m of msgs) this.emit('message', m);
        if (msgs.length === 0) {
          await new Promise((r) => setTimeout(r, config.transport.pollIdleMs));
        }
      } catch (err) {
        this.emit('error', err);
        this.emit('close', `polling error: ${err.message}`);
        return;
      }
    }
  }

  async send(obj) {
    await this.http.post('/send', obj);
  }

  close() {
    this.running = false;
  }
}

module.exports = { WsTransport, PollingTransport };
