import { createHash, webcrypto } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';

const NativeResponse = globalThis.Response;

class WorkerResponse extends NativeResponse {
  constructor(body, init = {}) {
    if (init.status === 101) {
      super(null, { headers: init.headers });
      Object.defineProperties(this, {
        status: { value: 101 },
        webSocket: { value: init.webSocket }
      });
    } else super(body, init);
  }
}

export class WorkerSocket extends EventTarget {
  constructor() {
    super();
    this.state = WebSocket.CONNECTING;
    this.pending = [];
    this.paused = false;
  }
  accept() { this.state = WebSocket.OPEN; }
  get readyState() { return this.socket?.readyState ?? this.state; }
  get bufferedAmount() { return this.socket?.bufferedAmount ?? 0; }
  send(data) {
    if (!this.socket) {
      if (this.state !== WebSocket.OPEN) throw new Error('WebSocket is closed');
      // Early-data handlers may send before the HTTP upgrade has completed.
      return new Promise((resolve, reject) => this.pending.push({ data, resolve, reject }));
    }
    return new Promise((resolve, reject) => this.socket.send(data, error => error ? reject(error) : resolve()));
  }
  close(code = 1000, reason = '') {
    if (this.socket) this.socket.close(code, reason);
    else {
      this.state = WebSocket.CLOSED;
      this.closeCode = code;
      this.closeReason = reason;
      for (const pending of this.pending.splice(0)) pending.reject(new Error('WebSocket is closed'));
    }
  }
  pause() { this.paused = true; this.socket?.pause(); }
  resume() { this.paused = false; this.socket?.resume(); }
  attach(socket) {
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.on('message', (data, binary) => {
      this.dispatchEvent(new MessageEvent('message', { data: binary ? data : data.toString() }));
    });
    socket.on('close', () => this.dispatchEvent(new Event('close')));
    socket.on('error', error => {
      const event = new Event('error');
      event.message = error.message;
      this.dispatchEvent(event);
    });
    if (this.paused) socket.pause();
    for (const { data, resolve, reject } of this.pending.splice(0)) this.send(data).then(resolve, reject);
    if (this.state === WebSocket.CLOSED) socket.close(this.closeCode, this.closeReason);
  }
}

class WebSocketPair {
  constructor() {
    this[1] = new WorkerSocket();
    this[0] = { server: this[1] };
  }
}

export function installRuntime() {
  globalThis.Response = WorkerResponse;
  globalThis.WebSocketPair = WebSocketPair;
  globalThis.WebSocket = WebSocket;
  // Workers supports MD5; Node's WebCrypto deliberately does not.
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, key) {
      if (key === 'digest') return async (algorithm, data) => {
        const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
        if (name.toUpperCase() === 'MD5') {
          const digest = createHash('md5').update(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength)).digest();
          return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
        }
        return target.digest(algorithm, data);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    subtle,
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    randomUUID: webcrypto.randomUUID.bind(webcrypto)
  } });
}

export function createConnector() {
  const sockets = new Set();
  let disposed = false;
  function connect({ hostname, port }, options = {}) {
    if (disposed) throw new Error('TCP connector is closed');
    const host = hostname.replace(/^\[|\]$/g, '');
    const secure = options.secureTransport === 'on';
    const params = { host, port: Number(port), allowHalfOpen: options.allowHalfOpen ?? false };
    const socket = secure ? tls.connect({ ...params, servername: net.isIP(host) ? undefined : host }) : net.connect(params);
    sockets.add(socket);
    socket.setNoDelay(true);
    let connected = false;
    const opened = new Promise((resolve, reject) => {
      socket.once(secure ? 'secureConnect' : 'connect', () => { connected = true; resolve(); });
      socket.once('error', reject);
      socket.once('close', () => { if (!connected) reject(new Error('Socket closed before connecting')); });
    });
    const closed = new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('close', () => { sockets.delete(socket); resolve(); });
    });
    // The worker may close losing race dials without awaiting these promises.
    opened.catch(() => {});
    closed.catch(() => {});
    const { readable, writable } = Duplex.toWeb(socket);
    return { readable, writable, opened, closed, localMode: true, close() { socket.destroy(); } };
  }
  return { connect, close() { disposed = true; for (const socket of sockets) socket.destroy(); }, get size() { return sockets.size; } };
}
