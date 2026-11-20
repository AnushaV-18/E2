'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderScheduler } = require('../scheduler');
const { ValidationError, DuplicateError, QueueFullError, RetryableError } = require('../errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const task = (id, run, extra = {}) => ({ requestId: id, tier: 'REGULAR', key: `p${id}`, run, ...extra });

test('100 simultaneous requests: none lost, none duplicated, each runs once', async () => {
  const s = new OrderScheduler({ workers: 4 });
  const runs = new Map();
  const jobs = Array.from({ length: 100 }, (_, i) => s.submit(task(`r${i}`, async () => {
    runs.set(`r${i}`, (runs.get(`r${i}`) || 0) + 1); await sleep(2); return i;
  })));
  const results = await Promise.all(jobs);
  assert.deepEqual(results, Array.from({ length: 100 }, (_, i) => i));
  assert.equal(runs.size, 100);
  assert.ok([...runs.values()].every((n) => n === 1));
  const m = s.metrics();
  assert.equal(m.completed, 100); assert.equal(m.failed, 0); assert.equal(m.queueLength, 0);
});

test('never more than `workers` orders run at the same time', async () => {
  const s = new OrderScheduler({ workers: 3 });
  let now = 0, peak = 0;
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.submit(task(`c${i}`, async () => {
    now++; peak = Math.max(peak, now); await sleep(5); now--;
  }))));
  assert.equal(peak, 3);
  assert.equal(s.metrics().maxActive, 3);
});

test('a repeated request ID is rejected and the order runs once', async () => {
  const s = new OrderScheduler();
  let n = 0;
  const first = s.submit(task('dup', async () => { n++; await sleep(5); return 'ok'; }));
  assert.throws(() => s.submit(task('dup', async () => { n++; })), DuplicateError);
  await first;
  assert.throws(() => s.submit(task('dup', async () => { n++; })), DuplicateError); // still rejected after it finished
  assert.equal(n, 1);
  assert.equal(s.metrics().duplicatesRejected, 2);
});

test('same resource key never runs together; different keys do', async () => {
  const s = new OrderScheduler({ workers: 4 });
  let sameNow = 0, samePeak = 0, otherNow = 0, otherPeak = 0;
  const same = (id) => s.submit({ requestId: id, tier: 'REGULAR', key: 'product:7', run: async () => { sameNow++; samePeak = Math.max(samePeak, sameNow); await sleep(5); sameNow--; } });
  const other = (id, k) => s.submit({ requestId: id, tier: 'REGULAR', key: k, run: async () => { otherNow++; otherPeak = Math.max(otherPeak, otherNow); await sleep(10); otherNow--; } });
  await Promise.all([same('a'), same('b'), same('c'), same('d'), other('x', 'product:1'), other('y', 'product:2'), other('z', 'product:3')]);
  assert.equal(samePeak, 1);
  assert.ok(otherPeak >= 2);
});

test('Plus orders are served before waiting Regular orders; FIFO inside a tier', async () => {
  const s = new OrderScheduler({ workers: 1 });
  const order = [];
  const mk = (id, tier) => s.submit({ requestId: id, tier, key: id, run: async () => { order.push(id); await sleep(2); } });
  const blocker = mk('blocker', 'REGULAR');               // occupies the only worker
  await sleep(1);
  await Promise.all([blocker, mk('r1', 'REGULAR'), mk('r2', 'REGULAR'), mk('p1', 'PLUS'), mk('p2', 'PLUS')]);
  assert.deepEqual(order, ['blocker', 'p1', 'p2', 'r1', 'r2']);
});

test('queue full: new order is rejected with 503 and can be retried later', async () => {
  const s = new OrderScheduler({ workers: 1, queueCapacity: 2 });
  const jobs = [s.submit(task('q0', () => sleep(20)))];   // running
  jobs.push(s.submit(task('q1', () => sleep(1))), s.submit(task('q2', () => sleep(1)))); // 2 waiting = full
  assert.throws(() => s.submit(task('q3', async () => {})), QueueFullError);
  await Promise.all(jobs);
  await s.submit(task('q3', async () => 'later'));        // same ID is accepted: the rejected request was not remembered
  assert.equal(s.metrics().rejectedQueueFull, 1);
});

test('invalid requests are rejected before queueing', () => {
  const s = new OrderScheduler();
  assert.throws(() => s.submit(null), ValidationError);
  assert.throws(() => s.submit({ requestId: '', tier: 'PLUS', key: 'k', run: async () => {} }), ValidationError);
  assert.throws(() => s.submit({ requestId: 'x', tier: 'GOLD', key: 'k', run: async () => {} }), ValidationError);
  assert.throws(() => s.submit({ requestId: 'x', tier: 'PLUS', key: 'k', run: 5 }), ValidationError);
  assert.equal(s.metrics().invalid, 4);
  assert.equal(s.metrics().submitted, 0);
});

test('worker failure: a RetryableError is re-queued once and then succeeds', async () => {
  const s = new OrderScheduler();
  let calls = 0;
  const r = await s.submit(task('t1', async () => { calls++; if (calls === 1) throw new RetryableError('db connection lost'); return 'done'; }));
  assert.equal(r, 'done'); assert.equal(calls, 2);
  assert.equal(s.metrics().retried, 1); assert.equal(s.status('t1'), 'DONE');
});

test('a RetryableError that keeps failing is rejected after maxRetries; other errors are never retried', async () => {
  const s = new OrderScheduler({ maxRetries: 1 });
  let a = 0, b = 0;
  await assert.rejects(s.submit(task('f1', async () => { a++; throw new RetryableError('still down'); })), RetryableError);
  await assert.rejects(s.submit(task('f2', async () => { b++; throw new Error('bug'); })), /bug/);
  assert.equal(a, 2); assert.equal(b, 1);
  assert.equal(s.metrics().failed, 2); assert.equal(s.status('f1'), 'FAILED');
});

test('a failing order does not block the others', async () => {
  const s = new OrderScheduler({ workers: 2 });
  const res = await Promise.allSettled([
    s.submit(task('g1', async () => { throw new Error('boom'); })),
    s.submit(task('g2', async () => 'fine')),
    s.submit(task('g3', async () => 'fine too')),
  ]);
  assert.deepEqual(res.map((x) => x.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.equal(s.metrics().active, 0);
});

test('status follows the order: QUEUED -> RUNNING -> DONE; unknown id -> UNKNOWN', async () => {
  const s = new OrderScheduler({ workers: 1 });
  const seen = [];
  const p1 = s.submit(task('s1', async () => { seen.push(s.status('s1')); await sleep(5); }));
  const p2 = s.submit(task('s2', async () => {}));
  seen.push(s.status('s2'));
  await Promise.all([p1, p2]);
  assert.deepEqual(seen, ['RUNNING', 'QUEUED']);
  assert.equal(s.status('s1'), 'DONE'); assert.equal(s.status('nope'), 'UNKNOWN');
});

test('metrics: average queue wait <= 2 s for 100 quick orders (NFR-03)', async () => {
  const s = new OrderScheduler({ workers: 4 });
  await Promise.all(Array.from({ length: 100 }, (_, i) => s.submit(task(`m${i}`, () => sleep(3)))));
  const m = s.metrics();
  assert.ok(m.avgWaitMs <= 2000, `avgWaitMs ${m.avgWaitMs}`);
  assert.ok(m.avgTurnaroundMs >= m.avgWaitMs);
  assert.equal(m.submitted, 100);
});
