import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { createApp } from './server.js';
import { FileKV } from './storage.js';
import { TUNNEL_LIMITS } from './limits.js';
import { setTimeout as delay } from 'node:timers/promises';

const ADMIN = 'integration-test-password-1234';
const UUID = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const agent = 'edgetunnel-test';

async function fixture(t, extra = {}, runtime = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'edgetunnel-test-'));
  const settings = { ADMIN, UUID, DATA_DIR: directory, PUBLIC_URL: 'http://localhost:8080', OFF_LOG: 'true', ...extra };
  const app = await createApp(settings, runtime);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function login() {
    const response = await fetch(base + '/login', { method: 'POST', headers: { 'User-Agent': agent }, body: new URLSearchParams({ password: ADMIN }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
    return response.headers.get('set-cookie').split(';')[0];
  }
  return { app, base, directory, settings, login };
}

async function echoServer(t) {
  const peers = new Set();
  const server = net.createServer(socket => {
    peers.add(socket);
    socket.on('data', data => socket.write(data));
    socket.on('error', () => {});
    socket.on('close', () => peers.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

function vless(port, payload, uuid = UUID) {
  return Buffer.concat([Buffer.from([0]), Buffer.from(uuid.replaceAll('-', ''), 'hex'), Buffer.from([0, 1, port >> 8, port & 255, 1, 127, 0, 0, 1]), payload]);
}

function receive(ws, length, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for tunnel response')); }, timeout);
    function cleanup() { clearTimeout(timer); ws.off('message', message); ws.off('error', fail); ws.off('close', closed); }
    function fail(error) { cleanup(); reject(error); }
    function closed() { fail(new Error('Tunnel closed before returning payload')); }
    function message(data) {
      chunks.push(Buffer.from(data)); bytes += data.byteLength;
      if (bytes >= length) { cleanup(); resolve(Buffer.concat(chunks)); }
    }
    ws.on('message', message); ws.on('error', fail); ws.on('close', closed);
  });
}

async function openWS(t, base, options = {}, path = '/') {
  const ws = new WebSocket(base.replace('http:', 'ws:') + path, options);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return ws;
}

test('local login, English pages, authentication, configuration and native subscriptions', async t => {
  const { app, base, login } = await fixture(t, { PATH: '/usr/bin:/bin' });
  assert.equal(app.env.PATH, undefined, 'OS PATH must not become the tunnel path');
  assert.equal((await fetch(base + '/healthz')).status, 200);
  const page = await fetch(base + '/login');
  assert.match(await page.text(), /Admin password/);
  const denied = await fetch(base + '/admin', { redirect: 'manual' });
  assert.equal(denied.headers.get('location'), '/login');
  const badLogin = await fetch(base + '/login', { method: 'POST', body: 'password=wrong' });
  assert.equal(badLogin.headers.get('set-cookie'), null);
  assert.match(await badLogin.text(), /Admin password/);
  const csrf = await fetch(base + '/login', { method: 'POST', headers: { Origin: 'http://attacker.test' }, body: `password=${ADMIN}` });
  assert.equal(csrf.status, 403);
  const cookie = await login();
  const headers = { Cookie: cookie, 'User-Agent': agent };
  const admin = await fetch(base + '/admin', { headers });
  assert.match(await admin.text(), /edgetunnel home server/);
  const response = await fetch(base + '/admin/config.json', { headers });
  const config = await response.json();
  const link = new URL(config.LINK);
  assert.equal(link.hostname, 'localhost');
  assert.equal(link.port, '8080');
  assert.equal(link.searchParams.get('security'), 'none');
  assert.equal(link.searchParams.get('path'), '/');
  const subscription = `/sub?token=${config.优选订阅生成.TOKEN}`;
  const mixed = await fetch(base + subscription);
  assert.equal(Buffer.from(await mixed.text(), 'base64').toString(), config.LINK);
  const clash = await (await fetch(base + subscription + '&target=clash')).json();
  assert.equal(clash.proxies[0].server, 'localhost');
  assert.equal(clash.proxies[0].port, 8080);
  assert.equal(clash.proxies[0].tls, false);
  const singbox = await (await fetch(base + subscription + '&target=singbox')).json();
  assert.equal(singbox.outbounds[0].uuid, UUID);
  assert.equal(singbox.outbounds[0].server_port, 8080);
  assert.equal(singbox.outbounds[0].tls, undefined);
  const invalid = await fetch(base + '/sub?token=invalid');
  assert.equal(invalid.status, 403);
  assert.ok(!(await invalid.text()).includes(UUID));
  const reset = await fetch(base + '/admin/init', { headers });
  assert.equal(reset.status, 405, 'GET must not reset saved configuration');
  config.优选订阅生成.SUBNAME = 'Saved home server';
  const save = await fetch(base + '/admin/config.json', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  assert.equal(save.status, 200);
  assert.equal(JSON.parse(await app.kv.get('config.json')).优选订阅生成.SUBNAME, 'Saved home server');
  config.传输协议 = 'grpc';
  const unsupported = await fetch(base + '/admin/config.json', { method: 'POST', headers, body: JSON.stringify(config) });
  assert.equal(unsupported.status, 400);
  assert.match(await unsupported.text(), /WebSocket/);
  assert.equal(JSON.parse(await app.kv.get('config.json')).传输协议, 'ws');
  config.传输协议 = 'ws';
  config.订阅转换配置 = 'broken';
  const malformed = await fetch(base + '/admin/config.json', { method: 'POST', headers, body: JSON.stringify(config) });
  assert.equal(malformed.status, 400);
  assert.match(await malformed.text(), /Incomplete configuration/);
});

test('HTTPS origin uses secure cookies and TLS links with a custom port', async t => {
  const { base, login } = await fixture(t, { PUBLIC_URL: 'https://vpn.example.com:8443' });
  const response = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ password: ADMIN }) });
  assert.match(response.headers.get('set-cookie'), /Secure/);
  const cookie = await login();
  const config = await (await fetch(base + '/admin/config.json', { headers: { Cookie: cookie, 'User-Agent': agent } })).json();
  const link = new URL(config.LINK);
  assert.equal(link.port, '8443');
  assert.equal(link.searchParams.get('sni'), 'vpn.example.com');
  assert.equal(link.searchParams.get('security'), 'tls');
});

test('VLESS WebSocket forwards initial and subsequent TCP payloads and cleans up on disconnect', async t => {
  const { app, base } = await fixture(t);
  const port = await echoServer(t);
  const ws = await openWS(t, base);
  const first = Buffer.from('hello through vless');
  const reply = receive(ws, first.length + 2);
  ws.send(vless(port, first));
  assert.deepEqual(await reply, Buffer.concat([Buffer.from([0, 0]), first]));
  const large = randomBytes(256 * 1024);
  const continued = receive(ws, large.length);
  ws.send(large);
  assert.deepEqual(await continued, large);
  const closed = once(ws, 'close');
  ws.close(); await closed;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.activeSockets, 0);
});

test('VLESS WebSocket early data reaches the TCP target', async t => {
  const { base } = await fixture(t);
  const port = await echoServer(t);
  const payload = Buffer.from('early-data');
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/', { headers: { 'Sec-WebSocket-Protocol': vless(port, payload).toString('base64url') } });
  t.after(() => ws.terminate());
  const reply = receive(ws, payload.length + 2);
  assert.deepEqual(await reply, Buffer.concat([Buffer.from([0, 0]), payload]));
});

test('invalid VLESS credentials close the tunnel without opening a TCP connection', async t => {
  const { app, base } = await fixture(t);
  const port = await echoServer(t);
  const ws = await openWS(t, base);
  const closed = once(ws, 'close');
  ws.send(vless(port, Buffer.from('denied'), '00000000-0000-4000-8000-000000000000'));
  await closed;
  assert.equal(app.activeSockets, 0);
});

test('Trojan WebSocket authenticates and forwards TCP payloads', async t => {
  const { base } = await fixture(t);
  const port = await echoServer(t);
  const ws = await openWS(t, base);
  const payload = Buffer.from('hello through trojan');
  const reply = receive(ws, payload.length);
  ws.send(Buffer.concat([Buffer.from(createHash('sha224').update(UUID).digest('hex') + '\r\n'),
    Buffer.from([1, 1, 127, 0, 0, 1, port >> 8, port & 255, 13, 10]), payload]));
  assert.deepEqual(await reply, payload);
});

// Independent Shadowsocks AEAD client: EVP_BytesToKey + HKDF-SHA1 + AES-GCM.
function masterKey(password) { return createHash('md5').update(password).digest(); }
function ssSession(salt) {
  return { key: Buffer.from(hkdfSync('sha1', masterKey(UUID), salt, Buffer.from('ss-subkey'), 16)), nonce: Buffer.alloc(12) };
}
function increment(nonce) {
  for (let i = 0; i < nonce.length; i++) { nonce[i] = (nonce[i] + 1) & 255; if (nonce[i] !== 0) break; }
}
function encrypt(session, plaintext) {
  const cipher = createCipheriv('aes-128-gcm', session.key, session.nonce);
  const result = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  increment(session.nonce); return result;
}
function decrypt(session, ciphertext) {
  const decipher = createDecipheriv('aes-128-gcm', session.key, session.nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const result = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  increment(session.nonce); return result;
}

test('Shadowsocks AES-128-GCM WebSocket encrypts and decrypts real TCP traffic', async t => {
  const { base } = await fixture(t);
  const port = await echoServer(t);
  const ws = await openWS(t, base, {}, '/?enc=aes-128-gcm');
  const payload = Buffer.from('hello through shadowsocks');
  const initial = Buffer.concat([Buffer.from([1, 127, 0, 0, 1, port >> 8, port & 255]), payload]);
  const salt = randomBytes(16), session = ssSession(salt);
  const length = Buffer.alloc(2); length.writeUInt16BE(initial.length);
  const reply = receive(ws, 16 + 18 + payload.length + 16);
  ws.send(Buffer.concat([salt, encrypt(session, length), encrypt(session, initial)]));
  const data = await reply;
  const remote = ssSession(data.subarray(0, 16));
  const count = decrypt(remote, data.subarray(16, 34)).readUInt16BE();
  assert.equal(count, payload.length);
  assert.deepEqual(decrypt(remote, data.subarray(34, 34 + count + 16)), payload);
});

test('Shadowsocks nonce carry and many-record streams preserve bidirectional payloads', async t => {
  const { app, base } = await fixture(t, { RUNTIME_PROFILE: 'small-vm' });
  const port = await echoServer(t);
  const ws = await openWS(t, base, {}, '/?enc=aes-128-gcm');
  const salt = randomBytes(16), session = ssSession(salt);
  const payload = randomBytes(3 * 1024 * 1024);
  let pending = Buffer.alloc(0), remote, size = null, received = 0;
  const plaintext = [];
  let resolve, reject;
  const reply = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => reject(new Error('Shadowsocks multi-record response timed out')), 10_000);
  t.after(() => clearTimeout(timer));
  ws.on('message', data => {
    try {
      pending = Buffer.concat([pending, data]);
      if (!remote) {
        if (pending.length < 16) return;
        remote = ssSession(pending.subarray(0, 16)); pending = pending.subarray(16);
      }
      while (true) {
        if (size === null) {
          if (pending.length < 18) return;
          size = decrypt(remote, pending.subarray(0, 18)).readUInt16BE(); pending = pending.subarray(18);
        }
        if (pending.length < size + 16) return;
        const data = decrypt(remote, pending.subarray(0, size + 16));
        plaintext.push(data); received += data.length;
        pending = pending.subarray(size + 16); size = null;
        if (received === payload.length) { clearTimeout(timer); resolve(Buffer.concat(plaintext)); }
      }
    } catch (error) { reject(error); }
  });
  ws.on('error', reject);
  const header = Buffer.from([1, 127, 0, 0, 1, port >> 8, port & 255]);
  let first = true;
  async function record(data) {
    const size = Buffer.alloc(2); size.writeUInt16BE(data.length);
    const frame = Buffer.concat([...(first ? [salt] : []), encrypt(session, size), encrypt(session, data)]);
    first = false;
    await new Promise((resolve, reject) => ws.send(frame, error => error ? reject(error) : resolve()));
  }
  await record(header);
  for (let offset = 0; offset < payload.length; offset += 0x3fff) await record(payload.subarray(offset, offset + 0x3fff));
  assert.deepEqual(await reply, payload);
  assert.ok(app.tunnelStats.peakQueuedBytes <= TUNNEL_LIMITS.connectionBytes);
});

test('file KV survives a new instance and serializes simultaneous writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'edgetunnel-kv-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const kv = new FileKV(directory);
  await Promise.all([kv.put('../unsafe/key', 'first'), kv.put('../unsafe/key', 'second')]);
  assert.equal(await new FileKV(directory).get('../unsafe/key'), 'second');
  await kv.put('json', '{"saved":true}');
  assert.deepEqual(await kv.get('json', 'json'), { saved: true });
  await kv.put('expired', 'hidden', { expiration: 1 });
  assert.equal(await kv.get('expired'), null);
});

test('generated UUID persists across server recreation', async t => {
  const { app, directory, settings } = await fixture(t, { UUID: '' });
  const saved = app.env.UUID;
  const second = await createApp({ ...settings, DATA_DIR: directory });
  assert.equal(second.env.UUID, saved);
  await second.close();
});

test('startup rejects missing passwords and invalid UUIDs', async () => {
  await assert.rejects(createApp({}), /ADMIN/);
  await assert.rejects(createApp({ ADMIN: 'replace-with-a-long-random-password' }), /ADMIN/);
  await assert.rejects(createApp({ ADMIN, UUID: 'bad' }), /UUIDv4/);
});

test('IPv6 public address is preserved in node links and subscription identity', async t => {
  const { base, login } = await fixture(t, { PUBLIC_URL: 'http://[::1]:8080' });
  const cookie = await login();
  const config = await (await fetch(base + '/admin/config.json', { headers: { Cookie: cookie, 'User-Agent': agent } })).json();
  assert.equal(config.HOST, '[::1]');
  assert.equal(new URL(config.LINK).hostname, '[::1]');
});

test('small-VM profile keeps authentication and disables expensive diagnostics', async t => {
  const { app, base } = await fixture(t, { RUNTIME_PROFILE: 'small-vm', DEBUG: 'true', OFF_LOG: 'false', TCP_CONCURRENT_DIAL: '4' });
  assert.equal(app.profile, 'small-vm');
  assert.equal(app.env.DEBUG, 'false');
  assert.equal(app.env.OFF_LOG, 'true');
  assert.equal(app.env.TCP_CONCURRENT_DIAL, '1');
  const port = await echoServer(t);
  const ws = await openWS(t, base);
  const reply = receive(ws, 6);
  ws.send(vless(port, Buffer.from('test')));
  assert.deepEqual(await reply, Buffer.from([0, 0, 116, 101, 115, 116]));
});

test('server rejects excess upgrades in English and reuses disconnected capacity', async t => {
  const { app, base } = await fixture(t, {}, { limits: { ...TUNNEL_LIMITS, connections: 1 } });
  const first = await openWS(t, base);
  const rejected = new WebSocket(base.replace('http:', 'ws:'));
  t.after(() => rejected.terminate());
  const response = await new Promise((resolve, reject) => {
    rejected.on('error', reject);
    rejected.on('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
  });
  assert.equal(response.status, 503);
  assert.match(response.body, /Tunnel capacity reached/);
  first.terminate();
  for (let i = 0; i < 100 && app.tunnelStats.connections; i++) await delay(10);
  assert.equal(app.tunnelStats.connections, 0);
  await openWS(t, base);
  assert.equal(app.tunnelStats.connections, 1);
});

test('idle and partial Shadowsocks handshakes hit authentication timeout', async t => {
  const { app, base } = await fixture(t, {}, { limits: { ...TUNNEL_LIMITS, authenticationMs: 100 } });
  for (const path of ['/', '/?enc=aes-128-gcm']) {
    const ws = await openWS(t, base, {}, path);
    const closed = once(ws, 'close');
    if (path.includes('enc')) ws.send(randomBytes(8));
    const [code, reason] = await closed;
    assert.equal(code, 1008);
    assert.match(reason.toString(), /authentication timed out/);
  }
  assert.equal(app.tunnelStats.queuedBytes, 0);
});

test('oversized WebSocket messages are rejected without opening outbound sockets', async t => {
  const { app, base } = await fixture(t);
  const ws = await openWS(t, base);
  const closed = once(ws, 'close');
  ws.send(Buffer.alloc(TUNNEL_LIMITS.messageBytes + 1));
  assert.equal((await closed)[0], 1009);
  assert.equal(app.activeSockets, 0);
  assert.equal(app.tunnelStats.queuedBytes, 0);
});

test('blocked TCP receiver pauses input and releases processing bytes after disconnect', async t => {
  const peers = new Set();
  const target = net.createServer(socket => {
    peers.add(socket); socket.pause(); socket.on('error', () => {});
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise(resolve => target.close(resolve)); });
  const { app, base } = await fixture(t);
  const ws = await openWS(t, base);
  ws.send(vless(target.address().port, Buffer.alloc(1)));
  const chunk = Buffer.alloc(64 * 1024);
  for (let i = 0; i < 200 && ws.readyState === WebSocket.OPEN; i++) {
    ws.send(chunk);
    await delay(1);
    if (app.tunnelStats.pauses && app.tunnelStats.queuedBytes >= TUNNEL_LIMITS.pauseBytes) break;
  }
  assert.ok(app.tunnelStats.pauses > 0);
  assert.ok(app.tunnelStats.queuedBytes <= TUNNEL_LIMITS.connectionBytes);
  ws.terminate();
  for (let i = 0; i < 200 && (app.tunnelStats.queuedBytes || app.tunnelStats.connections || app.activeSockets); i++) await delay(10);
  assert.equal(app.tunnelStats.queuedBytes, 0);
  assert.equal(app.tunnelStats.connections, 0);
  assert.equal(app.activeSockets, 0);
});

test('slow WebSocket receiver does not block other tunnels and cleans up on disconnect', async t => {
  const peers = new Set();
  const target = net.createServer(socket => {
    peers.add(socket); socket.on('error', () => {});
    socket.once('data', () => {
      let remaining = 8 * 1024 * 1024;
      function send() {
        while (remaining > 0 && !socket.destroyed) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, remaining), 7);
          remaining -= chunk.length;
          if (!socket.write(chunk)) { socket.once('drain', send); return; }
        }
      }
      send();
    });
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise(resolve => target.close(resolve)); });
  const { app, base } = await fixture(t);
  const slow = await openWS(t, base);
  slow.pause(); slow.send(vless(target.address().port, Buffer.from('download')));
  const port = await echoServer(t);
  const fast = await openWS(t, base);
  const reply = receive(fast, 4);
  fast.send(vless(port, Buffer.from('ok')));
  assert.deepEqual(await reply, Buffer.from([0, 0, 111, 107]));
  slow.terminate(); fast.terminate();
  for (let i = 0; i < 200 && (app.activeSockets || app.tunnelStats.connections); i++) await delay(10);
  assert.equal(app.activeSockets, 0);
  assert.equal(app.tunnelStats.queuedBytes, 0);
});

test('destination EOF before a response cannot crash the application through fallback rejection', async t => {
  const target = net.createServer(socket => socket.end());
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  t.after(() => new Promise(resolve => target.close(resolve)));
  const { app, base } = await fixture(t);
  const ws = await openWS(t, base);
  const closed = once(ws, 'close');
  ws.send(vless(target.address().port, Buffer.alloc(0)));
  await closed;
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal(app.activeSockets, 0);
});
