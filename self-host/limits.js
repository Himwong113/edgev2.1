export const TUNNEL_LIMITS = Object.freeze({
  connections: 128,
  messageBytes: 512 * 1024,
  connectionBytes: 1024 * 1024,
  globalBytes: 32 * 1024 * 1024,
  pauseBytes: 256 * 1024,
  resumeBytes: 64 * 1024,
  messages: 4096,
  authenticationMs: 10_000,
});

// One budget per application, never a process-global budget shared by test apps.
export class TunnelBudget {
  constructor(limits = TUNNEL_LIMITS) {
    this.limits = limits;
    this.connections = 0;
    this.bytes = 0;
    this.peakBytes = 0;
    this.pauses = 0;
  }
  open(onFailure) {
    if (this.connections >= this.limits.connections) return null;
    this.connections++;
    return new TunnelControl(this, onFailure);
  }
}

class TunnelControl {
  constructor(budget, onFailure) {
    this.budget = budget;
    this.onFailure = onFailure;
    this.queue = [];
    this.bytes = 0;
    this.messages = 0;
    this.paused = false;
    this.stopped = false;
    this.disposed = false;
    this.authenticated = false;
    this.running = null;
    this.timer = setTimeout(() => this.fail(new Error('Tunnel authentication timed out')),
      budget.limits.authenticationMs).unref();
  }
  setSocket(socket) {
    this.socket = socket;
    if (this.paused) socket.pause();
  }
  authenticate() {
    if (this.stopped) throw new Error('Tunnel is closed');
    this.authenticated = true;
    clearTimeout(this.timer);
  }
  enqueue(data, process) {
    if (this.stopped) return;
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    const limits = this.budget.limits;
    if (!Number.isSafeInteger(size) || size > limits.messageBytes) {
      this.fail(new Error('WebSocket message exceeds the size limit')); return;
    }
    if (this.bytes + size > limits.connectionBytes || this.messages >= limits.messages
      || this.budget.bytes + size > limits.globalBytes) {
      this.fail(new Error('Tunnel queue capacity exceeded')); return;
    }
    this.bytes += size;
    this.messages++;
    this.budget.bytes += size;
    this.budget.peakBytes = Math.max(this.budget.peakBytes, this.budget.bytes);
    this.queue.push({ data, size, process });
    if (!this.paused && this.bytes >= limits.pauseBytes) {
      this.paused = true;
      this.budget.pauses++;
      this.socket?.pause();
    }
    this.schedule();
  }
  schedule() {
    if (this.running || this.stopped) return;
    // Defer execution so running is assigned before a synchronous failure.
    this.running = Promise.resolve().then(() => this.drain()).finally(() => {
      this.running = null;
      // An enqueue can occur between drain resolution and this continuation.
      if (this.queue.length && !this.stopped) this.schedule();
    });
  }
  release(size) {
    this.bytes -= size;
    this.messages--;
    this.budget.bytes -= size;
    if (this.paused && this.bytes < this.budget.limits.resumeBytes) {
      this.paused = false;
      this.socket?.resume();
    }
  }
  async drain() {
    while (!this.stopped && this.queue.length) {
      const entry = this.queue.shift();
      try { await entry.process(entry.data); }
      catch (error) { this.fail(error); }
      finally { this.release(entry.size); }
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    // Discard queued references immediately. Processing bytes remain reserved
    // until their operation settles after the owning TCP connector is closed.
    for (const entry of this.queue.splice(0)) this.release(entry.size);
    if (this.paused) { this.paused = false; this.socket?.resume(); }
  }
  fail(error) {
    if (this.stopped) return;
    this.stop();
    this.onFailure(error);
  }
  close() {
    this.stop();
    if (!this.disposed) { this.disposed = true; this.budget.connections--; }
  }
  async idle() { while (this.running) await this.running; }
}
