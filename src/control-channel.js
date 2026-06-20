const EventEmitter = require('events');
const config = require('./config');
const logger = require('./logger');
const { WsTransport, PollingTransport } = require('./transports');

// Orchestrator of a resilient control channel to the TestMW relay.
//
// Responsibilities of this layer:
//   1) Transport selection: 'auto' tries WS, and after wsFailThreshold
//      consecutive failures degrades to long-polling (DPI blocks WS but not
//      plain HTTPS).
//   2) Auto-reconnect with exponential backoff + jitter.
//   3) A single outward interface: a 'message' event and a send() method — the
//      code above (the browser bridge) does not care which transport is below.
//
// Events: 'up' (channel is up), 'down' (channel went down, reconnecting),
//         'message' (object from the server).
class ControlChannel extends EventEmitter {
  constructor() {
    super();
    this.transport = null;
    this.connected = false;
    this.stopped = false;
    this.attempt = 0;        // attempt counter for backoff
    this.wsFails = 0;        // consecutive WS failures (for degradation)
    this.usePolling = config.transport.mode === 'polling';
  }

  // Pick the transport class for the current attempt.
  _pickTransport() {
    if (config.transport.mode === 'ws') return new WsTransport();
    if (config.transport.mode === 'polling') return new PollingTransport();
    // auto: until the WS failure threshold is exceeded — try WS, else polling.
    return this.usePolling ? new PollingTransport() : new WsTransport();
  }

  _backoffDelay() {
    const { baseMs, maxMs, jitter } = config.backoff;
    const exp = Math.min(maxMs, baseMs * 2 ** Math.min(this.attempt, 10));
    const delta = exp * jitter;
    return Math.round(exp - delta + Math.random() * 2 * delta);
  }

  async start() {
    this.stopped = false;
    await this._connectLoop();
  }

  async _connectLoop() {
    while (!this.stopped) {
      const t = this._pickTransport();
      const kind = t instanceof PollingTransport ? 'polling' : 'ws';
      this.transport = t;

      // Attach subscriptions before connect so we don't miss early messages.
      t.on('message', (obj) => this.emit('message', obj));
      t.on('error', (err) => logger.debug(`Transport error (${kind}): ${err.message}`));

      const closed = new Promise((resolve) => t.once('close', resolve));

      try {
        await t.connect();
        this.connected = true;
        this.attempt = 0;
        if (kind === 'ws') this.wsFails = 0;
        logger.info(`Channel is up (${kind})`);
        this.emit('up', kind);

        // Stay alive until the transport closes.
        const reason = await closed;
        logger.warn(`Channel closed: ${reason}`);
      } catch (err) {
        // Could not even connect.
        if (kind === 'ws' && config.transport.mode === 'auto') {
          this.wsFails += 1;
          if (this.wsFails >= config.transport.wsFailThreshold) {
            this.usePolling = true;
            logger.warn(
              `WS failed to come up ${this.wsFails} time(s) in a row — degrading to polling`
            );
          }
        }
        logger.debug(`Connection (${kind}) failed: ${err.message}`);
      } finally {
        try { t.removeAllListeners(); t.close(); } catch { /* no-op */ }
      }

      if (this.connected) { this.connected = false; this.emit('down'); }
      if (this.stopped) break;

      this.attempt += 1;
      const delay = this._backoffDelay();
      logger.info(`Reconnecting in ${delay} ms (attempt ${this.attempt})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  async send(obj) {
    if (!this.transport || !this.connected) throw new Error('Channel is not up');
    await this.transport.send(obj);
  }

  stop() {
    this.stopped = true;
    if (this.transport) { try { this.transport.close(); } catch { /* no-op */ } }
  }
}

module.exports = ControlChannel;
