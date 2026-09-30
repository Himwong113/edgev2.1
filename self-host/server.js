import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { FileKV } from './storage.js';
import { createConnector, installRuntime } from './runtime.js';
import { makeNodeLink, makeSubscription } from './subscriptions.js';

installRuntime();
const { default: worker } = await import('../_worker.js');

export async function createApp(settings = process.env) {
  if (!settings.ADMIN || settings.ADMIN === 'replace-with-a-long-random-password' || settings.ADMIN.trim().length < 16 || /[\r\n]/.test(settings.ADMIN)) {
    throw new Error('Set ADMIN to a password of at least 16 characters, or run npm run setup');
  }
  const publicURL = new URL(settings.PUBLIC_URL || 'http://localhost:8080');
  if (!['http:', 'https:'].includes(publicURL.protocol) || publicURL.username || publicURL.password || publicURL.pathname !== '/' || publicURL.search || publicURL.hash) {
    throw new Error('PUBLIC_URL must be an http(s) origin, e.g. https://vpn.example.com');
  }
  const origin = publicURL.origin;
  const kv = new FileKV(settings.DATA_DIR || './data');
  let uuid = settings.UUID;
  if (!uuid) {
    uuid = await kv.get('identity');
    if (!uuid) { uuid = randomUUID(); await kv.put('identity', uuid); }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) throw new Error('UUID must be a valid UUIDv4');
  // Do not pass the OS PATH into the worker's unrelated tunnel PATH setting.
  const forwarded = Object.fromEntries(['ADMIN', 'KEY', 'PROXYIP', 'URL', 'GO2SOCKS5', 'DEBUG', 'OFF_LOG', 'PROXY_CONCURRENT_DIAL']
    .filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
  // The Request already uses PUBLIC_URL; let the worker read its hostname,
  // avoiding the upstream HOST-list parser's IPv6 colon stripping.
  const env = { ...forwarded, UUID: uuid, LOCAL_MODE: true, KV: kv,
    ...(settings.TUNNEL_PATH ? { PATH: settings.TUNNEL_PATH } : {}),
    TCP_CONCURRENT_DIAL: settings.TCP_CONCURRENT_DIAL || '1',
    validateConfig(config) {
      const object = value => value && typeof value === 'object' && !Array.isArray(value);
      if (!object(config) || typeof config.UUID !== 'string' || typeof config.HOST !== 'string'
        || ![config.优选订阅生成, config.优选订阅生成?.本地IP库, config.订阅转换配置,
          config.反代, config.反代?.SOCKS5, config.TG, config.SS].every(object)) {
        return 'Incomplete configuration; keep all existing configuration sections';
      }
      if (typeof config.PATH !== 'string' || !config.PATH.startsWith('/')
        || !Array.isArray(config.HOSTS) || !config.HOSTS.every(host => typeof host === 'string')
        || typeof config.优选订阅生成.SUBNAME !== 'string') return 'Invalid path, host list, or node name';
      if (!['aes-128-gcm', 'aes-256-gcm'].includes(config.SS.加密方式)) return 'Shadowsocks cipher must be aes-128-gcm or aes-256-gcm';
      try { makeNodeLink(config, origin); return null; } catch (error) { return error.message; }
    },
    makeNodeLink: config => makeNodeLink(config, origin),
    makeSubscription: (config, request) => makeSubscription(config, request, origin) };
  const pages = new Map(await Promise.all(['login', 'admin'].map(async name => [name, await readFile(new URL(`./public/${name}.html`, import.meta.url), 'utf8')])));
  const clientJS = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  env.ASSETS = { fetch(request) {
    const page = pages.get(new URL(request.url).pathname.slice(1));
    return new Response(page || 'Page not found', { status: page ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  } };
  const background = new Set();
  const connectors = new Set();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024,
    handleProtocols: () => false }); // sec-websocket-protocol carries early data, not an actual negotiated protocol.
  const ctx = { waitUntil(promise) {
    const pending = Promise.resolve(promise).catch(error => console.error('Background task failed:', error.message));
    background.add(pending);
    pending.finally(() => background.delete(pending));
  } };

  function toRequest(raw, connector, signal) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(raw.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    for (const name of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-forwarded-for', 'fly-client-ip', 'x-appengine-remote-addr', 'x-cluster-client-ip']) headers.delete(name);
    headers.set('CF-Connecting-IP', raw.socket.remoteAddress || 'unknown');
    headers.set('Host', publicURL.host);
    const request = new Request(origin + raw.url, { method: raw.method, headers, signal,
      ...(!['GET', 'HEAD'].includes(raw.method) ? { body: Readable.toWeb(raw), duplex: 'half' } : {}) });
    request.cf = { colo: 'LOCAL', asn: 0, asOrganization: 'Self-hosted' };
    request.fetcher = connector;
    return request;
  }

  const server = http.createServer(async (raw, res) => {
    const connector = createConnector();
    connectors.add(connector);
    const abort = new AbortController();
    res.once('close', () => { abort.abort(); connector.close(); connectors.delete(connector); });
    try {
      const request = toRequest(raw, connector, abort.signal);
      const path = new URL(request.url).pathname;
      if (raw.method === 'POST' && raw.headers.origin && raw.headers.origin !== origin) {
        res.writeHead(403); res.end('Origin does not match PUBLIC_URL'); return;
      }
      if (path === '/admin/init' && raw.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }); res.end('Reset configuration with an authenticated POST request'); return;
      }
      if (raw.method === 'POST' && path !== '/login' && !path.startsWith('/admin/')) {
        res.writeHead(501); res.end('Use WebSocket transport for self-hosted deployment'); return;
      }
      let response;
      if (path === '/healthz') response = Response.json({ status: 'ok' });
      else if (path === '/self-host.js') response = new Response(clientJS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
      else response = await worker.fetch(request, env, ctx);
      res.statusCode = response.status;
      // Node fetch decompresses responses; stale upstream length/encoding headers must not be forwarded.
      for (const [key, value] of response.headers) {
        if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'set-cookie'].includes(key)) res.setHeader(key, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (response.body && raw.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res);
      else { await response.body?.cancel(); res.end(); }
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error('Request failed:', error.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Request failed; check server logs');
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on('upgrade', async (raw, socket, head) => {
    const connector = createConnector();
    connectors.add(connector);
    const abort = new AbortController();
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { abort.abort(); connector.close(); connectors.delete(connector); });
    try {
      const response = await worker.fetch(toRequest(raw, connector, abort.signal), env, ctx);
      if (response.status !== 101 || !response.webSocket) {
        await response.body?.cancel();
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      if (socket.destroyed) return;
      wss.handleUpgrade(raw, socket, head, ws => {
        response.webSocket.server.attach(ws);
        ws.alive = true;
        ws.on('pong', () => { ws.alive = true; });
        ws.once('close', () => connector.close());
      });
    } catch (error) {
      connector.close();
      console.error('Upgrade failed:', error.message);
      socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 30_000);
  heartbeat.unref();
  return { server, kv, env, get activeSockets() { return [...connectors].reduce((sum, connector) => sum + connector.size, 0); },
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      for (const connector of connectors) connector.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...background]);
      await new Promise(resolve => wss.close(resolve));
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const app = await createApp();
    const port = Number(process.env.PORT || 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
    app.server.on('error', error => { console.error(error.message); process.exit(1); });
    app.server.listen(port, process.env.LISTEN_HOST || '127.0.0.1', () => {
      console.log(`edgetunnel listening on ${process.env.LISTEN_HOST || '127.0.0.1'}:${port}; admin: ${process.env.PUBLIC_URL || 'http://localhost:8080'}/admin`);
    });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), 10_000).unref();
      await app.close();
      clearTimeout(deadline);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
