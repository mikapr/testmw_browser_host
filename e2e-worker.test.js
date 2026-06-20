// e2e через РЕАЛЬНЫЙ код воркера: Worker.connectRemoteBrowser() +
// getBrowserFor() override. Поднимаем relay + browser-host (как в e2e-full),
// но коннект делает настоящий класс Worker из webboy_worker_new.
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const Worker = require('../webboy_worker_new/src/worker');

const SECRET = 'worker-e2e-secret';
const RELAY_PORT = 8097, API_PORT = 8098;
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
  const api = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (req.url === '/host/me') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, userId: 7 })); }
      else if (req.url === '/host/heartbeat') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, hostId: 42, relaySecret: SECRET })); }
      else { res.writeHead(200); res.end('{}'); }
    });
  });
  await new Promise(r => api.listen(API_PORT, r));

  spawnNode(RELAY_DIR, { PORT: String(RELAY_PORT), SERVER_API_URL: `http://127.0.0.1:${API_PORT}`, HOST_RELAY_SECRET: SECRET, LOG_LEVEL: 'info' });
  await wait(1200);
  spawnNode(HOST_DIR, { RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}/host`, WORKER_TOKEN: 'tok', HOST_NAME: 'worker-e2e', TRANSPORT_MODE: 'ws', HEADLESS: 'true', LOG_LEVEL: 'info' });
  await wait(2500);

  // Дескриптор как его формирует сервер (HostRoutingService::connectionDescriptor)
  const descriptor = {
    host_id: 42,
    relay_url: `ws://127.0.0.1:${RELAY_PORT}`,
    session_token: mint({ task_id: 1, host_id: 42, user_id: 7, exp: Math.floor(Date.now() / 1000) + 120 }),
  };

  const worker = new Worker();
  console.log('WORKER: connectRemoteBrowser…');
  worker._remoteBrowser = await worker.connectRemoteBrowser(descriptor);
  console.log('WORKER: подключился ✅');

  // getBrowserFor должен вернуть удалённый браузер (override), а не локальный пул.
  const br = await worker.getBrowserFor('chromium');
  const sameAsRemote = br === worker._remoteBrowser;
  const ctx = await br.newContext();
  const page = await ctx.newPage();
  await page.setContent('<title>WORKER_PATH_OK</title>');
  const title = await page.title();
  await worker._remoteBrowser.close();
  worker._remoteBrowser = null;

  // override снят → getBrowserFor больше НЕ должен возвращать удалённый
  console.log('WORKER: title =', title, '| getBrowserFor→remote =', sameAsRemote);
  const pass = title === 'WORKER_PATH_OK' && sameAsRemote;
  console.log(pass ? 'WORKER_E2E_PASS ✅' : 'WORKER_E2E_FAIL ❌');
  cleanup(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e.stack || e.message); cleanup(1); });

setTimeout(() => { console.error('GLOBAL TIMEOUT'); cleanup(1); }, 45000);
