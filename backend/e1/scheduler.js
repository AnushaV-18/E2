'use strict';
// E1 - Concurrent Order Process Scheduler.
//   job queue  -> ready queue (Plus before Regular) -> worker slots -> task.run()
// Guarantees:  every accepted request runs exactly once (request-ID check), at most `workers` run at once,
// and two orders for the same resource key never run together (critical-section control).
const defaults = require('./config');
const { ReadyQueue } = require('./priorityQueue');
const { ValidationError, DuplicateError, QueueFullError, RetryableError } = require('./errors');

const TIERS = new Set(['PLUS', 'REGULAR']);
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // milliseconds, monotonic

class OrderScheduler {
  constructor(cfg = {}) {
    this.cfg = { ...defaults, ...cfg };
    this.queue = new ReadyQueue();
    this.runningKeys = new Set();         // resource keys currently being processed (the "locks")
    this.seen = new Map();                // requestId -> { state, at }
    this.active = 0;
    this.m = { submitted: 0, completed: 0, failed: 0, retried: 0, duplicates: 0, rejectedFull: 0, invalid: 0,
               starts: 0, totalWaitMs: 0, maxWaitMs: 0, totalTurnaroundMs: 0, maxActive: 0 };
  }

  /**
   * task: { requestId: string, tier: 'PLUS'|'REGULAR', key: string, run: async () => result }
   * Returns a promise for run()'s result. Rejects with ValidationError (400), DuplicateError (409),
   * QueueFullError (503) or whatever run() throws.
   */
  submit(task) {
    if (!task || typeof task.requestId !== 'string' || !task.requestId.trim()) { this.m.invalid++; throw new ValidationError('requestId is required'); }
    if (!TIERS.has(task.tier)) { this.m.invalid++; throw new ValidationError('tier must be PLUS or REGULAR'); }
    if (typeof task.key !== 'string' || !task.key) { this.m.invalid++; throw new ValidationError('key is required'); }
    if (typeof task.run !== 'function') { this.m.invalid++; throw new ValidationError('run must be a function'); }
    this._forgetOld();
    if (this.seen.has(task.requestId)) { this.m.duplicates++; throw new DuplicateError(`request ${task.requestId} was already received`); }
    if (this.queue.size >= this.cfg.queueCapacity) { this.m.rejectedFull++; throw new QueueFullError('system is busy, please try again shortly'); }

    this.m.submitted++;
    this.seen.set(task.requestId, { state: 'QUEUED', at: Date.now() });
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject, enqueuedAt: now(), attempts: 0 });
      this._pump();
    });
  }

  status(requestId) {
    const s = this.seen.get(requestId);
    return s ? s.state : 'UNKNOWN';
  }

  // Start work while there is a free worker and a queued order whose key is not already running.
  _pump() {
    while (this.active < this.cfg.workers) {
      const item = this.queue.takeFirst((it) => !this.runningKeys.has(it.task.key));
      if (!item) return;
      this._start(item);
    }
  }

  async _start(item) {
    const { task } = item;
    this.active++; this.runningKeys.add(task.key);
    this.m.maxActive = Math.max(this.m.maxActive, this.active);
    const startedAt = now();
    const wait = startedAt - item.enqueuedAt;
    this.m.starts++; this.m.totalWaitMs += wait; this.m.maxWaitMs = Math.max(this.m.maxWaitMs, wait);
    this._mark(task.requestId, 'RUNNING');
    try {
      const result = await task.run();
      this.m.completed++; this.m.totalTurnaroundMs += now() - item.enqueuedAt;
      this._mark(task.requestId, 'DONE');
      item.resolve(result);
    } catch (err) {
      if (err instanceof RetryableError && item.attempts < this.cfg.maxRetries) {
        item.attempts++; this.m.retried++;
        item.enqueuedAt = now();
        this._mark(task.requestId, 'QUEUED');
        this.queue.pushFront(item);          // go back to the front of its tier
      } else {
        this.m.failed++; this.m.totalTurnaroundMs += now() - item.enqueuedAt;
        this._mark(task.requestId, 'FAILED');
        item.reject(err);
      }
    } finally {
      this.active--; this.runningKeys.delete(task.key);
      this._pump();
    }
  }

  _mark(requestId, state) { const s = this.seen.get(requestId); if (s) { s.state = state; s.at = Date.now(); } }

  // Forget finished request IDs after the TTL (and cap memory); queued/running ones are never forgotten.
  _forgetOld() {
    if (this.seen.size < this.cfg.dedupeMax / 2) return;
    const cutoff = Date.now() - this.cfg.dedupeTtlMs;
    for (const [id, s] of this.seen) {
      if ((s.state === 'DONE' || s.state === 'FAILED') && (s.at < cutoff || this.seen.size >= this.cfg.dedupeMax)) this.seen.delete(id);
    }
  }

  metrics() {
    const m = this.m, finished = m.completed + m.failed;
    const r = (x) => Math.round(x * 100) / 100;
    return {
      workers: this.cfg.workers, queueLength: this.queue.size, active: this.active, maxActive: m.maxActive,
      submitted: m.submitted, completed: m.completed, failed: m.failed, retried: m.retried,
      duplicatesRejected: m.duplicates, rejectedQueueFull: m.rejectedFull, invalid: m.invalid,
      avgWaitMs: m.starts ? r(m.totalWaitMs / m.starts) : 0,
      maxWaitMs: r(m.maxWaitMs),
      avgTurnaroundMs: finished ? r(m.totalTurnaroundMs / finished) : 0,
    };
  }
}

module.exports = { OrderScheduler };
