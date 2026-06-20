// Full e2e: relay (real) + browser-host (real, with Chromium) + a worker that
// does chromium.connect through the relay and really drives the browser in the
// "user's network". The mock API server serves /host/me|heartbeat|offline.
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('./node_modules/playwright');
const { WebSocket } = require('./node_modules/ws');

const SECRET = 'full-e2e-secret';
const RELAY_PORT = 8095, API_PORT = 8096;
const RELAY_DIR = path.resolve(__dirname, '../webboy_relay');
const HOST_DIR = __dirname;

const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mint = p => { const body = b64url(JSON.stringify(p)); const sig = crypto.createHmac('sha256', SECRET).update(body).digest(); return body + '.' + b64url(sig); };

const procs = [];
function spawnNode(dir, env) {
  const p = spawn(process.execPath, ['src/index.js'], { cwd: dir, env: { ...process.env, ...env } });
  p.stdout.on('data', d => process.stdout.write(`[${path.basename(dir)}] ${d}`));
  p.stderr.on('data', d => process.stdout.write(`[${path.basename(dir)}!] ${d}`));
  procs.push(p);
  return p;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
function cleanup(code) { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } process.exit(code); }

(async () => {
  // 1) Mock API server
  const api = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (req.url === '/host/me') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, userId: 163 })); }
      else if (req.url === '/host/heartbeat') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, hostId: 99, relaySecret: SECRET })); }
      else if (req.url === '/host/offline') { res.writeHead(200); res.end('{}'); }
      else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise(r => api.listen(API_PORT, r));

  // 2) Relay (separate process)
  spawnNode(RELAY_DIR, {
    PORT: String(RELAY_PORT), SERVER_API_URL: `http://127.0.0.1:${API_PORT}`,
    HOST_RELAY_SECRET: SECRET, LOG_LEVEL: 'info',
  });
  await wait(1200);

  // 3) Browser-host (separate process, real Chromium)
  spawnNode(HOST_DIR, {
    RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}/host`, WORKER_TOKEN: 'agenttoken',
    HOST_NAME: 'e2e-host', TRANSPORT_MODE: 'ws', HEADLESS: 'true', LOG_LEVEL: 'info',
  });
  // wait for the agent to register (heartbeat) with the relay
  await wait(2500);

  // 4) Worker: chromium.connect through the relay and real browser control
  const token = mint({ task_id: 555, host_id: 99, user_id: 163, exp: Math.floor(Date.now() / 1000) + 120 });
  const wsUrl = `ws://127.0.0.1:${RELAY_PORT}/connect?token=${encodeURIComponent(token)}`;
  console.log('WORKER: chromium.connect →', wsUrl);

  const browser = await chromium.connect(wsUrl, { timeout: 15000 });
  console.log('WORKER: подключился к удалённому браузеру ✅');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<title>TESTMW_REMOTE_OK</title><h1>hi from user network</h1>');
  const title = await page.title();
  const h1 = await page.textContent('h1');
  console.log('WORKER: title =', title, '| h1 =', h1);
  await browser.close();

  const pass = title === 'TESTMW_REMOTE_OK' && h1 === 'hi from user network';
  console.log(pass ? 'FULL_E2E_PASS ✅' : 'FULL_E2E_FAIL ❌');
  cleanup(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e.stack || e.message); cleanup(1); });

setTimeout(() => { console.error('GLOBAL TIMEOUT'); cleanup(1); }, 45000);
