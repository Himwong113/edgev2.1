// Isolated loopback/Docker benchmark. Never point this at a production endpoint.
import net from 'node:net';
import { once } from 'node:events';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const exec = promisify(execFile);
const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, 'target-host': { type: 'string', default: '127.0.0.1' },
  'tls-endpoint': { type: 'string' }, 'insecure-test-tls': { type: 'boolean', default: false },
  duration: { type: 'string', default: '0' }, bytes: { type: 'string', default: '33554432' },
  containers: { type: 'string', default: '' }, label: { type: 'string', default: 'local' },
  protocols: { type: 'string', default: 'vless,trojan,ss' },
} });
const uuid = process.env.BENCHMARK_UUID;
const duration = Number(values.duration), transferBytes = Number(values.bytes);
const protocols = values.protocols.split(',');
if (!protocols.length || protocols.some(protocol => !['vless', 'trojan', 'ss'].includes(protocol))) throw new Error('Protocols must be vless, trojan, or ss');
if (!values.endpoint || !/^[0-9a-f-]{36}$/i.test(uuid || '') || !net.isIPv4(values['target-host'])
  || !Number.isInteger(duration) || duration < 0 || duration > 3600
  || !Number.isInteger(transferBytes) || transferBytes < 1024 || transferBytes > 512 * 1024 * 1024) {
  throw new Error('Use --endpoint ws://127.0.0.1:PORT --target-host IPv4 and BENCHMARK_UUID for an isolated test server; duration must be 0–3600 seconds');
}
for (const endpoint of [values.endpoint, values['tls-endpoint']].filter(Boolean)) {
  const url = new URL(endpoint);
  if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Benchmark endpoints must be loopback WebSocket addresses');
  }
}

const chunk = Buffer.alloc(64 * 1024, 7), sockets = new Set();
const target = net.createServer(socket => {
  sockets.add(socket); socket.setNoDelay(true);
  socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
  let header = Buffer.alloc(0), mode, remaining;
  function download() {
    while (remaining && !socket.destroyed) {
      const data = chunk.subarray(0, Math.min(remaining, chunk.length));
      remaining -= data.length;
      if (!socket.write(data)) { socket.once('drain', download); return; }
    }
  }
  socket.on('data', data => {
    if (!mode) {
      header = Buffer.concat([header, data]);
      if (header.length < 5) return;
      mode = String.fromCharCode(header[0]); remaining = header.readUInt32BE(1);
      data = header.subarray(5); header = null;
      if (mode === 'D') { download(); return; }
    }
    if (mode === 'E') socket.write(data);
    else if (mode === 'U') {
      remaining -= data.length;
      if (remaining < 0) { socket.destroy(new Error('Upload exceeded expected length')); return; }
      if (remaining === 0) { const ack = Buffer.alloc(4); ack.writeUInt32BE(transferBytes); socket.write(ack); }
    }
  });
});
target.listen(0, '0.0.0.0'); await once(target, 'listening');
const port = target.address().port;
const address = Buffer.from([1, ...values['target-host'].split('.').map(Number), port >> 8, port & 255]);
const password = Buffer.from(uuid);
const master = createHash('md5').update(password).digest();
function session(salt) { return { key: Buffer.from(hkdfSync('sha1', master, salt, Buffer.from('ss-subkey'), 16)), nonce: Buffer.alloc(12) }; }
function increment(nonce) {
  for (let i = 0; i < nonce.length; i++) { nonce[i] = (nonce[i] + 1) & 255; if (nonce[i] !== 0) break; }
}
function encrypt(state, data) {
  const cipher = createCipheriv('aes-128-gcm', state.key, state.nonce);
  const result = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  increment(state.nonce); return result;
}
function decrypt(state, data) {
  const cipher = createDecipheriv('aes-128-gcm', state.key, state.nonce);
  cipher.setAuthTag(data.subarray(-16));
  const result = Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]);
  increment(state.nonce); return result;
}

const channels = new Set();
async function open(protocol, endpoint = values.endpoint) {
  const raw = protocol === 'tcp';
  const url = new URL(endpoint);
  if (protocol === 'ss') url.searchParams.set('enc', 'aes-128-gcm');
  const socket = raw ? net.connect({ host: '127.0.0.1', port }) : new WebSocket(url, {
    perMessageDeflate: false, rejectUnauthorized: !values['insecure-test-tls'],
  });
  let received = 0, tail = Buffer.alloc(0), failure, waiter;
  let pending = Buffer.alloc(0), inbound, length = null, vlessHeader = protocol === 'vless' ? 2 : 0;
  const salt = randomBytes(16), outbound = session(salt);
  let sendSalt = true;
  function fail(error) { failure = error; waiter?.reject(error); }
  function plaintext(data) {
    if (vlessHeader) {
      const skip = Math.min(vlessHeader, data.length); vlessHeader -= skip; data = data.subarray(skip);
    }
    received += data.length;
    tail = Buffer.concat([tail, data.subarray(-32)]).subarray(-32);
    if (waiter && received >= waiter.goal) { const current = waiter; waiter = null; current.resolve(); }
  }
  function message(data) {
    try {
      if (protocol !== 'ss') { plaintext(data); return; }
      pending = Buffer.concat([pending, data]);
      if (!inbound) {
        if (pending.length < 16) return;
        inbound = session(pending.subarray(0, 16)); pending = pending.subarray(16);
      }
      while (true) {
        if (length === null) {
          if (pending.length < 18) return;
          length = decrypt(inbound, pending.subarray(0, 18)).readUInt16BE(); pending = pending.subarray(18);
        }
        if (pending.length < length + 16) return;
        plaintext(decrypt(inbound, pending.subarray(0, length + 16)));
        pending = pending.subarray(length + 16); length = null;
      }
    } catch (error) { fail(error); }
  }
  socket.on(raw ? 'data' : 'message', message);
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Benchmark channel closed')));
  if (raw) socket.setNoDelay(true);
  const channel = {
    get received() { return received; }, get tail() { return tail; },
    async send(data) {
      if (failure) throw failure;
      if (protocol === 'ss') {
        for (let offset = 0; offset < data.length; offset += 0x3fff) {
          const part = data.subarray(offset, offset + 0x3fff), size = Buffer.alloc(2);
          size.writeUInt16BE(part.length);
          const frame = Buffer.concat([...(sendSalt ? [salt] : []), encrypt(outbound, size), encrypt(outbound, part)]);
          sendSalt = false;
          await new Promise((resolve, reject) => socket.send(frame, error => error ? reject(error) : resolve()));
        }
      } else await new Promise((resolve, reject) => {
        const done = error => error ? reject(error) : resolve();
        if (raw) socket.write(data, done); else socket.send(data, done);
      });
    },
    async wait(goal) {
      if (failure) throw failure;
      if (received >= goal) return;
      let timer;
      try {
        await new Promise((resolve, reject) => {
          waiter = { goal, resolve, reject };
          timer = setTimeout(() => reject(new Error('Benchmark transfer timed out')), 30_000);
        });
      } finally { clearTimeout(timer); waiter = null; }
    },
    close() { channels.delete(channel); if (raw) socket.destroy(); else socket.terminate(); },
  };
  channels.add(channel);
  try {
    await once(socket, raw ? 'connect' : 'open');
    if (protocol === 'vless') await channel.send(Buffer.concat([Buffer.from([0]), Buffer.from(uuid.replaceAll('-', ''), 'hex'),
      Buffer.from([0, 1, port >> 8, port & 255]), address.subarray(0, 5)]));
    if (protocol === 'trojan') await channel.send(Buffer.concat([Buffer.from(createHash('sha224').update(uuid).digest('hex') + '\r\n'),
      Buffer.from([1]), address, Buffer.from('\r\n')]));
    if (protocol === 'ss') await channel.send(address);
    return channel;
  } catch (error) { channel.close(); throw error; }
}

function command(mode) { const result = Buffer.alloc(5); result[0] = mode.charCodeAt(0); result.writeUInt32BE(transferBytes, 1); return result; }
async function transfer(protocol, direction, endpoint) {
  const channel = await open(protocol, endpoint);
  try {
    await channel.send(command(direction));
    if (direction === 'U') {
      for (let offset = 0; offset < transferBytes; offset += chunk.length) await channel.send(chunk.subarray(0, Math.min(chunk.length, transferBytes - offset)));
      await channel.wait(4);
      if (channel.received !== 4 || channel.tail.readUInt32BE() !== transferBytes) throw new Error('Upload acknowledgement mismatch');
    } else {
      await channel.wait(transferBytes);
      if (channel.received !== transferBytes || channel.tail.some(byte => byte !== 7)) throw new Error('Download content mismatch');
    }
  } finally { channel.close(); }
}
async function batch(protocol, direction, concurrency, endpoint) {
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => transfer(protocol, direction, endpoint)));
  return Number((transferBytes * concurrency * 8 / ((performance.now() - start) * 1000)).toFixed(2));
}
async function echo(protocol, endpoint, count) {
  const channel = await open(protocol, endpoint);
  const samples = [];
  try {
    await channel.send(command('E'));
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      await channel.send(chunk.subarray(0, 64)); await channel.wait((i + 1) * 64);
      if (i >= 5) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return Number((samples[Math.ceil(samples.length * .95) - 1] || 0).toFixed(3));
  } finally { channel.close(); }
}

const containerNames = values.containers.split(',').filter(Boolean);
if (containerNames.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name))) throw new Error('Invalid test container name');
const resources = {};
async function sampleResources() {
  for (const name of containerNames) {
    const { stdout } = await exec('docker', ['exec', name, 'sh', '-c',
      'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/cpu.stat']);
    const lines = stdout.trim().split('\n'), current = Number(lines[0]), peak = Number(lines[1]);
    const cpu = Number(lines.find(line => line.startsWith('usage_usec ')).split(' ')[1]);
    const previous = resources[name], now = performance.now();
    resources[name] = { idleBytes: previous?.idleBytes ?? current, currentBytes: current, maxBytes: Math.max(previous?.maxBytes || 0, current),
      cgroupPeakBytes: peak, peakCpuPercent: Math.max(previous?.peakCpuPercent || 0,
        previous ? (cpu - previous.cpu) / ((now - previous.time) * 10) : 0), cpu, time: now };
  }
}
let monitorBusy = false, monitorError;
await sampleResources();
const monitor = setInterval(async () => {
  if (monitorBusy) return;
  monitorBusy = true;
  try { await sampleResources(); } catch (error) { monitorError = error.message; }
  finally { monitorBusy = false; }
}, 5000);

const report = { label: values.label, date: new Date().toISOString(), node: process.version,
  bytesPerStream: transferBytes, throughput: [], latencyP95Ms: {}, errors: 0 };
try {
  for (const protocol of ['tcp', ...protocols, ...(values['tls-endpoint'] ? ['vless-tls'] : [])]) {
    const kind = protocol === 'vless-tls' ? 'vless' : protocol;
    const endpoint = protocol === 'vless-tls' ? values['tls-endpoint'] : values.endpoint;
    for (const concurrency of [1, 5]) for (const direction of ['U', 'D']) {
      const mbps = await batch(kind, direction, concurrency, endpoint);
      report.throughput.push({ protocol, direction, concurrency, mbps });
      console.log(JSON.stringify({ phase: 'throughput', protocol, direction, concurrency, mbps }));
    }
    report.latencyP95Ms[protocol] = await echo(kind, endpoint, 105);
  }
  const idle = await Promise.all(Array.from({ length: 64 }, async () => {
    const channel = await open('vless');
    await channel.send(command('E')); await channel.send(chunk.subarray(0, 64)); await channel.wait(64);
    return channel;
  }));
  await delay(1000); await sampleResources();
  report.idle64Bytes = Object.fromEntries(Object.entries(resources).map(([name, value]) => [name, value.currentBytes]));
  for (let i = 0; i < 100; i++) await echo('vless', values.endpoint, 6);
  report.churnConnections = 100;
  const start = performance.now(); let rounds = 0, lastProgress = start, totalBytes = 0;
  while (performance.now() - start < duration * 1000) {
    const protocol = ['vless', 'trojan', 'ss', ...(values['tls-endpoint'] ? ['vless-tls'] : [])][rounds % (values['tls-endpoint'] ? 4 : 3)];
    const kind = protocol === 'vless-tls' ? 'vless' : protocol;
    const endpoint = protocol === 'vless-tls' ? values['tls-endpoint'] : values.endpoint;
    await batch(kind, Math.floor(rounds / (values['tls-endpoint'] ? 4 : 3)) % 2 ? 'U' : 'D', 5, endpoint);
    rounds++; totalBytes += transferBytes * 5;
    if (performance.now() - lastProgress >= 60_000) {
      console.log(JSON.stringify({ phase: 'sustained', seconds: Math.round((performance.now() - start) / 1000), rounds, errors: 0 }));
      lastProgress = performance.now();
    }
  }
  report.sustained = { seconds: Number(((performance.now() - start) / 1000).toFixed(2)), rounds, totalBytes, idleTunnels: idle.length };
  for (const channel of idle) channel.close();
} catch (error) {
  report.errors++; report.failure = error.message; process.exitCode = 1;
} finally {
  clearInterval(monitor);
  while (monitorBusy) await delay(10);
  try { await sampleResources(); } catch (error) { monitorError = error.message; }
  report.resources = Object.fromEntries(Object.entries(resources).map(([name, { cpu, time, ...value }]) => [name, value]));
  if (monitorError) { report.monitorError = monitorError; process.exitCode = 1; }
  report.containerState = {};
  for (const name of containerNames) {
    const { stdout } = await exec('docker', ['inspect', '--format', '{{json .State}} {{.RestartCount}}', name]);
    const split = stdout.trim().lastIndexOf(' '), state = JSON.parse(stdout.slice(0, split));
    report.containerState[name] = { running: state.Running, oomKilled: state.OOMKilled, restarts: Number(stdout.slice(split + 1)) };
  }
  for (const channel of channels) channel.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => target.close(resolve));
  console.log('BENCHMARK_REPORT ' + JSON.stringify(report));
}
