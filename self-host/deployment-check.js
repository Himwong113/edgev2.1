import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const exec = promisify(execFile);
const { values } = parseArgs({ options: { image: { type: 'string', default: 'edgetunnel-self-hosted:small-vm-test' } } });
const project = 'edgetunnel-smallvm-verify';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, ADMIN: randomBytes(24).toString('hex'), UUID: randomUUID(), KEY: '',
  PUBLIC_URL: 'https://localhost', VPN_DOMAIN: 'localhost', BIND_ADDRESS: '127.0.0.1', HTTP_PORT: '0',
  TUNNEL_PATH: '/', PROXYIP: '', OFF_LOG: 'true', DEBUG: 'false', VERIFY_IMAGE: values.image };
const composeArgs = ['compose', '--env-file', '/dev/null', '-p', project,
  '-f', 'compose.yaml', '-f', 'compose.https.yaml', '-f', 'compose.small-vm.yaml',
  '-f', 'compose.small-vm.https.yaml', '-f', 'deploy/compose.verify.yaml'];
const docker = async args => (await exec('docker', args, { cwd, env, timeout: 90_000, maxBuffer: 1024 * 1024 })).stdout.trim();
const compose = args => docker([...composeArgs, ...args]);
if (await compose(['ps', '-aq'])
  || await docker(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'])
  || await docker(['network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'])) {
  throw new Error('The isolated verification project already exists; refusing to modify it');
}

let tlsPort, started = false;
const peers = new Set();
const target = net.createServer(socket => {
  peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
  socket.pipe(socket);
});
function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    // The isolated localhost Caddy uses its internal CA. This exception is
    // intentionally limited to this test, never the production server/client.
    const req = https.request({ hostname: 'localhost', port: tlsPort, path, method,
      rejectUnauthorized: false, timeout: 5000, headers: { 'User-Agent': 'edgetunnel-deployment-check', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Verification request timed out')));
    req.end(body);
  });
}
try {
  started = true;
  await compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '60']);
  tlsPort = Number((await compose(['port', 'caddy', '443'])).split(':').at(-1));
  assert.equal((await request('/healthz')).status, 200);
  console.log('PASS: isolated Docker startup, HTTP health, and Caddy HTTPS');
  const login = await request('/login', { method: 'POST', body: new URLSearchParams({ password: env.ADMIN }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(login.status, 200);
  assert.equal(JSON.parse(login.body).success, true);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const headers = { Cookie: cookie };
  const config = JSON.parse((await request('/admin/config.json', { headers })).body);
  assert.equal(config.UUID, env.UUID);
  assert.equal(new URL(config.LINK).searchParams.get('security'), 'tls');
  config.优选订阅生成.SUBNAME = 'small-vm-persistence-check';
  assert.equal((await request('/admin/config.json', { method: 'POST', headers: { ...headers,
    'Content-Type': 'application/json' }, body: JSON.stringify(config) })).status, 200);
  await compose(['restart', 'tunnel']);
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await request('/healthz')).status === 200) { healthy = true; break; } } catch (_) { }
    await delay(500);
  }
  assert.ok(healthy, 'Restarted tunnel became healthy');
  const saved = JSON.parse((await request('/admin/config.json', { headers })).body);
  assert.equal(saved.优选订阅生成.SUBNAME, 'small-vm-persistence-check');
  assert.equal(saved.UUID, env.UUID);
  console.log('PASS: English login, TLS client link, and settings persistence after restart');

  target.listen(0, '0.0.0.0'); await once(target, 'listening');
  const gateway = JSON.parse(await docker(['network', 'inspect', `${project}_default`]))[0].IPAM.Config[0].Gateway;
  assert.ok(net.isIPv4(gateway));
  const targetPort = target.address().port, payload = randomBytes(256 * 1024);
  const ws = new WebSocket(`wss://localhost:${tlsPort}/`, { rejectUnauthorized: false, perMessageDeflate: false });
  try {
    await once(ws, 'open');
    const response = new Promise((resolve, reject) => {
      const chunks = []; let count = 0;
      const timer = setTimeout(() => reject(new Error('Caddy tunnel response timed out')), 10_000);
      ws.on('message', data => {
        chunks.push(data); count += data.length;
        if (count >= payload.length + 2) { clearTimeout(timer); resolve(Buffer.concat(chunks)); }
      });
      ws.on('error', error => { clearTimeout(timer); reject(error); });
      ws.on('close', () => { clearTimeout(timer); reject(new Error('Verification tunnel closed')); });
    });
    ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(env.UUID.replaceAll('-', ''), 'hex'),
      Buffer.from([0, 1, targetPort >> 8, targetPort & 255, 1, ...gateway.split('.').map(Number)]), payload]));
    assert.deepEqual(await response, Buffer.concat([Buffer.from([0, 0]), payload]));
  } finally { ws.terminate(); }
  console.log('PASS: real VLESS traffic through Caddy TLS (256 KiB)');
  for (const [service, memory] of [['tunnel', 192], ['caddy', 96]]) {
    const id = await compose(['ps', '-q', service]);
    const state = JSON.parse(await docker(['inspect', '--format', '{{json .HostConfig}}', id]));
    assert.equal(state.Memory, memory * 1024 * 1024);
    assert.equal(state.MemorySwap, state.Memory);
    assert.equal(state.PidsLimit, 64);
    if (service === 'tunnel') assert.equal(state.NanoCpus, 1_000_000_000);
  }
  console.log('PASS: effective container memory, swap, process, and CPU limits');
} finally {
  for (const peer of peers) peer.destroy();
  if (target.listening) await new Promise(resolve => target.close(resolve));
  if (started) {
    await compose(['down', '--volumes', '--remove-orphans']);
    console.log('Cleaned up only the isolated verification project and its temporary test volumes');
  }
}
