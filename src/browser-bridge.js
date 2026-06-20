const WebSocket = require('ws');
const { chromium } = require('playwright');
const config = require('./config');
const logger = require('./logger');
const { getProxyAgent } = require('./proxy');

// Bridge to the browser. On the relay's `launch` command it spins up a local
// Playwright browser server (chromium.launchServer) and transparently bridges
// its wsEndpoint to the relay through a data channel:
//
//   [worker] ──/connect──► [relay] ──/host/data──► [this agent] ──► [Chromium]
//                                                  (data WS)   (local WS to wsEndpoint)
//
// The agent keeps TWO sockets per session and shuttles Playwright-protocol
// frames between them. The browser physically runs inside the user's network —
// the worker (chromium.connect through the relay) runs actions in it.
//
// Each task = its own launchServer (isolation, just like a regular worker).
class BrowserBridge {
  constructor() {
    // sessionId → { server, browserWs, dataWs }
    this.sessions = new Map();
    // Relay data-channel URL = control URL + '/data'
    // (config.relayUrl = …/host → …/host/data; nginx strips it to /host/data).
    this.dataUrl = config.relayUrl.replace(/\/$/, '') + '/data';
  }

  count() {
    return this.sessions.size;
  }

  /** Spin up a browser for the session and bridge it to the relay. */
  async launch(sessionId) {
    if (this.sessions.has(sessionId)) {
      logger.warn(`launch: session ${sessionId} already exists — ignoring`);
      return;
    }
    if (this.sessions.size >= config.browser.maxSessions) {
      throw new Error(`reached the cap on simultaneous sessions (${config.browser.maxSessions})`);
    }

    const entry = { server: null, browserWs: null, dataWs: null };
    this.sessions.set(sessionId, entry);

    // Any failure mid-setup (launchServer / socket open rejected by the relay)
    // must tear down whatever was already created — otherwise a live Chromium
    // and the session slot leak, and after maxSessions failures the agent stops
    // accepting launches. close() handles partial state (null-safe).
    try {
      // 1) Local browser server.
      const server = await chromium.launchServer({
        headless: config.browser.headless,
        args: config.browser.args,
      });
      entry.server = server;
      const wsEndpoint = server.wsEndpoint();
      logger.info(`Session ${sessionId}: browser launched (${wsEndpoint.replace(/\/[0-9a-f]+$/i, '/…')})`);

      // 2) Local socket to the browser (loopback, no proxy/TLS). We open it
      //    first and wait for `open` — so that by the time frames arrive from
      //    the worker the channel to Chromium is ready.
      const browserWs = new WebSocket(wsEndpoint, { perMessageDeflate: false });
      entry.browserWs = browserWs;
      await new Promise((resolve, reject) => {
        browserWs.once('open', resolve);
        browserWs.once('error', reject);
      });

      // 3) Outbound data channel to the relay (proxy/CA as on the control channel).
      const { agent } = getProxyAgent(this.dataUrl);
      const dataWs = new WebSocket(this.dataUrl, {
        agent,
        rejectUnauthorized: !config.tls.insecure,
        perMessageDeflate: false,
        headers: {
          authorization: `Bearer ${config.token}`,
          'x-session-id': sessionId,
        },
      });
      entry.dataWs = dataWs;
      await new Promise((resolve, reject) => {
        dataWs.once('open', resolve);
        dataWs.once('error', reject);
      });

      // 4) Transparent pipe in both directions (preserving the frame type).
      this._pipe(sessionId, dataWs, browserWs);
      logger.info(`Session ${sessionId}: bridged to the relay`);
    } catch (err) {
      await this.close(sessionId, `launch error: ${err.message}`);
      throw err;
    }
  }

  _pipe(sessionId, dataWs, browserWs) {
    const fwd = (from, to) => {
      from.on('message', (data, isBinary) => {
        if (to.readyState === WebSocket.OPEN) {
          try { to.send(data, { binary: isBinary }); } catch { /* no-op */ }
        }
      });
    };
    fwd(dataWs, browserWs);
    fwd(browserWs, dataWs);

    const teardown = (reason) => this.close(sessionId, reason);
    dataWs.on('close', () => teardown('data channel closed'));
    browserWs.on('close', () => teardown('browser closed'));
    dataWs.on('error', () => teardown('data channel error'));
    browserWs.on('error', () => teardown('browser error'));
  }

  /** Close the session: tear down both sockets and stop the browser server. */
  async close(sessionId, reason = '') {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    logger.info(`Session ${sessionId}: closing${reason ? ' (' + reason + ')' : ''}`);
    try { entry.dataWs?.close(); } catch { /* no-op */ }
    try { entry.browserWs?.close(); } catch { /* no-op */ }
    try { await entry.server?.close(); } catch { /* no-op */ }
  }

  /** Stop all sessions (graceful shutdown). */
  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id, 'shutdown')));
  }
}

module.exports = BrowserBridge;
