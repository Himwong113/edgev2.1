import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { TUNNEL_LIMITS, TunnelBudget } from './limits.js';
import { WorkerSocket, createConnector } from './runtime.js';

function setup(overrides = {}) {
  const budget = new TunnelBudget({ ...TUNNEL_LIMITS, ...overrides });
  const errors = [];
  const control = budget.open(error => errors.push(error));
  const calls = [];
  control.setSocket({ pause: () => calls.push('pause'), resume: () => calls.push('resume') });
  return { budget, control, errors, calls };
}

test('queue counts processing bytes and pauses/resumes at byte thresholds', async () => {
  const { budget, control, calls } = setup({ pauseBytes: 8, resumeBytes: 3 });
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  control.enqueue(Buffer.alloc(8), () => blocked);
  control.enqueue(Buffer.alloc(2), async () => {});
  await Promise.resolve();
  assert.equal(control.bytes, 10);
  assert.equal(budget.bytes, 10);
  assert.deepEqual(calls, ['pause']);
  unblock();
  await control.idle();
  assert.equal(budget.bytes, 0);
  assert.equal(control.messages, 0);
  assert.deepEqual(calls, ['pause', 'resume']);
  control.close();
});

test('per-connection hard limit discards queued references, but holds processing reservation', async () => {
  const { budget, control, errors } = setup({ connectionBytes: 10 });
  let unblock;
  control.enqueue(Buffer.alloc(6), () => new Promise(resolve => { unblock = resolve; }));
  await Promise.resolve();
  control.enqueue(Buffer.alloc(4), async () => assert.fail('Discarded entry ran'));
  control.enqueue(Buffer.alloc(1), async () => {});
  assert.match(errors[0].message, /capacity/);
  assert.equal(control.queue.length, 0);
  assert.equal(budget.bytes, 6);
  control.close(); control.close();
  assert.equal(budget.connections, 0);
  unblock();
  await control.idle();
  assert.equal(budget.bytes, 0);
});

test('global budget is shared and reusable after a failed connection', async () => {
  const { budget, control } = setup({ globalBytes: 10 });
  let unblock;
  control.enqueue(Buffer.alloc(7), () => new Promise(resolve => { unblock = resolve; }));
  await Promise.resolve();
  let failure;
  const second = budget.open(error => { failure = error; });
  second.enqueue(Buffer.alloc(4), async () => {});
  assert.match(failure.message, /capacity/);
  assert.equal(budget.bytes, 7);
  second.close();
  unblock(); await control.idle();
  const third = budget.open(() => assert.fail('Released budget was not reusable'));
  third.enqueue(Buffer.alloc(10), async () => {});
  await third.idle();
  control.close(); third.close();
  assert.equal(budget.bytes, 0);
  assert.equal(budget.connections, 0);
});

test('tiny-message count limit prevents unbounded pending tasks', async () => {
  const { control, budget, errors } = setup({ messages: 2 });
  control.enqueue(Buffer.alloc(0), async () => {});
  control.enqueue(Buffer.alloc(0), async () => {});
  control.enqueue(Buffer.alloc(0), async () => {});
  await control.idle();
  assert.match(errors[0].message, /capacity/);
  assert.equal(control.messages, 0);
  assert.equal(budget.bytes, 0);
  control.close();
});

test('processing failure and repeated close release counters exactly once', async () => {
  const { budget, control, errors } = setup();
  control.enqueue(Buffer.alloc(4), async () => { throw new Error('Write failed'); });
  control.enqueue(Buffer.alloc(5), async () => assert.fail('Queued task ran after failure'));
  await control.idle();
  assert.equal(errors.length, 1);
  control.close(); control.close();
  assert.equal(budget.bytes, 0);
  assert.equal(budget.connections, 0);
});

test('capacity includes unauthenticated connections and released slots are reusable', () => {
  const budget = new TunnelBudget();
  const controls = Array.from({ length: 128 }, () => budget.open(() => {}));
  assert.equal(budget.open(() => {}), null);
  controls[0].close();
  const replacement = budget.open(() => {});
  assert.ok(replacement);
  for (const control of controls) control.close();
  replacement.close();
  assert.equal(budget.connections, 0);
});

test('authentication timer expires, authentication clears it, and close clears it', async () => {
  assert.equal(TUNNEL_LIMITS.authenticationMs, 10_000);
  const expired = setup({ authenticationMs: 20 });
  const authenticated = setup({ authenticationMs: 20 });
  authenticated.control.authenticate();
  const closed = setup({ authenticationMs: 20 });
  closed.control.close();
  await delay(50);
  assert.match(expired.errors[0].message, /authentication timed out/);
  assert.equal(authenticated.errors.length, 0);
  assert.equal(closed.errors.length, 0);
  expired.control.close(); authenticated.control.close();
});

test('oversized messages never reserve queue bytes', () => {
  const { budget, control, errors } = setup();
  control.enqueue(Buffer.alloc(TUNNEL_LIMITS.messageBytes + 1), async () => {});
  assert.match(errors[0].message, /size limit/);
  assert.equal(budget.bytes, 0);
  control.close();
});

test('enqueue during drain settlement is scheduled and included in idle cleanup', async () => {
  const { control, budget } = setup();
  let calls = 0;
  const drain = control.drain.bind(control);
  control.drain = async () => {
    await drain();
    if (calls++ === 0) queueMicrotask(() => control.enqueue(Buffer.alloc(1), async () => { calls++; }));
  };
  control.enqueue(Buffer.alloc(1), async () => {});
  await control.idle();
  assert.ok(calls >= 2);
  assert.equal(control.queue.length, 0);
  assert.equal(budget.bytes, 0);
  control.close();
});

test('runtime applies pause before attachment and awaits early sends', async () => {
  const socket = new WorkerSocket();
  socket.accept(); socket.pause();
  let callback, resolved = false;
  const sent = socket.send(Buffer.from('early')).then(() => { resolved = true; });
  const native = new EventEmitter();
  const calls = [];
  Object.assign(native, { readyState: 1, pause: () => calls.push('pause'), resume: () => calls.push('resume'),
    send: (_data, done) => { callback = done; } });
  socket.attach(native);
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.deepEqual(calls, ['pause']);
  callback(); await sent;
  socket.resume();
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('closing a runtime socket rejects unattached sends and blocks late TCP creation', async () => {
  const socket = new WorkerSocket();
  socket.accept();
  const sent = socket.send(Buffer.alloc(1));
  socket.close();
  await assert.rejects(sent, /closed/);
  const connector = createConnector();
  connector.close();
  assert.throws(() => connector.connect({ hostname: '127.0.0.1', port: 1 }), /closed/);
});
