'use strict';
// Tunable constants for E1. The handbook fixes the targets (100 simultaneous requests, average wait <= 2 s);
// the numbers below are defaults - agree them with your team and write the final values in your handbook.
module.exports = {
  workers: Number(process.env.E1_WORKERS) || 4,              // how many orders may be processed at the same time ("worker threads")
  queueCapacity: Number(process.env.E1_QUEUE_CAPACITY) || 500,      // waiting orders allowed before new ones are rejected (HTTP 503)
  maxRetries: 1,           // a worker that hits a RetryableError puts the order back in the queue once
  dedupeTtlMs: 10 * 60e3,  // a request ID is remembered this long so repeats are rejected
  dedupeMax: 20000,        // safety cap on remembered request IDs
};
