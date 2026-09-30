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

const ADMIN = 'integration-test-password-1234';
const UUID = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const agent = 'edgetunnel-test';

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'edgetunnel-test-'));
  const settings = { ADMIN, UUID, DATA_DIR: directory, PUBLIC_URL: 'http://localhost:8080', OFF_LOG: 'true', ...extra };
  const app = await createApp(settings);
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
  assert.ok(!(await invalid.text()).includes(UUID));
  config.优选订阅生成.SUBNAME = 'Saved home server';
  const save = await fetch(base + '/admin/config.json', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  assert.equal(save.status, 200);
  assert.equal(JSON.parse(await app.kv.get('config.json')).优选订阅生成.SUBNAME, 'Saved home server');
  config.传输协议 = 'grpc';
  const unsupported = await fetch(base + '/admin/config.json', { method: 'POST', headers, body: JSON.stringify(config) });
  assert.equal(unsupported.status, 400);
  assert.match(await unsupported.text(), /WebSocket/);
  assert.equal(JSON.parse(await app.kv.get('config.json')).传输协议, 'ws');
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
function increment(nonce) { for (let i = 0; i < nonce.length; i++) { if (++nonce[i] !== 0) break; } }
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
  await assert.rejects(createApp({ ADMIN, UUID: 'bad' }), /UUIDv4/);
});
