const config = require('./config');
const logger = require('./logger');
const ControlChannel = require('./control-channel');
const BrowserBridge = require('./browser-bridge');

// Entry point of the TestMW Browser Host thin agent.
//
// The agent:
//   • keeps a resilient control channel to the relay (WSS → proxy → polling),
//   • registers with its token, keeps a heartbeat and reconnects,
//   • on the relay's `launch` command spins up a local Playwright browser
//     server and bridges it to the relay (BrowserBridge) — the TestMW worker
//     does chromium.connect() through the relay and runs actions in the user's
//     browser.

async function main() {
  const bridge = new BrowserBridge();
  if (!config.token) {
    logger.error('WORKER_TOKEN is not set — the agent cannot bind to an account. ' +
      'Get a token in the TestMW dashboard and set it in .env (WORKER_TOKEN=...).');
    process.exit(1);
  }

  logger.info(`TestMW Browser Host "${config.name}" is starting`);
  logger.info(`Relay: ${config.relayUrl} (transport mode: ${config.transport.mode})`);

  const channel = new ControlChannel();

  channel.on('up', (kind) => {
    // Every time the channel comes up we announce ourselves to the server:
    // name, version, capabilities. On this event the server marks the host
    // online.
    channel.send({
      type: 'hello',
      name: config.name,
      version: require('../package.json').version,
      transport: kind,
      // capabilities — what the agent can do; for now only launching a browser.
      capabilities: ['chromium'],
    }).catch((e) => logger.warn(`Failed to send hello: ${e.message}`));
  });

  channel.on('down', () => logger.warn('Channel is down — reconnecting'));

  channel.on('message', (msg) => {
    switch (msg?.type) {
      case 'hello_ack':
        logger.info(`Server accepted registration (hostId=${msg.hostId ?? msg.workerId ?? '?'})`);
        break;
      case 'launch':
        // The relay asks to spin up a browser for the session and bridge it to
        // the worker. The browser itself opens an outbound data channel to the
        // relay — the control channel (which may have degraded to polling) is
        // not used to pump the protocol.
        bridge.launch(msg.sessionId).catch((e) => {
          logger.error(`launch of session ${msg.sessionId} failed: ${e.message}`);
          channel.send({ type: 'launch_failed', sessionId: msg.sessionId, error: e.message })
            .catch(() => {});
        });
        break;
      case 'session_close':
        bridge.close(msg.sessionId, 'relay command');
        break;
      default:
        logger.debug(`Incoming message: ${JSON.stringify(msg).slice(0, 200)}`);
    }
  });

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${sig} — shutting down the agent`);
    channel.stop();
    await bridge.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await channel.start();
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
