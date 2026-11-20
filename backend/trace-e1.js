// Demo run of the E1 scheduler: 2 workers, mixed Plus/Regular orders, two orders for the same product, a repeated request ID.
const { OrderScheduler } = require('./e1/scheduler');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = new OrderScheduler({ workers: 2 });
const log = [];
const job = (id, tier, key, ms) => s.submit({ requestId: id, tier, key, run: async () => {
  log.push(`START ${id.padEnd(8)} ${tier.padEnd(7)} ${key}   (active=${s.active}, waiting=${s.queue.size})`); await sleep(ms); log.push(`END   ${id}`); return id; } });
(async () => {
  const jobs = [
    job('reg-A', 'REGULAR', 'product:1', 30),
    job('reg-B', 'REGULAR', 'product:2', 30),
    job('reg-C', 'REGULAR', 'product:1', 10),   // same product as reg-A: must wait for it
    job('reg-D', 'REGULAR', 'product:3', 10),
    job('plus-E', 'PLUS', 'product:4', 10),     // arrives last but is served before waiting Regular orders
  ];
  try { await job('reg-A', 'REGULAR', 'product:1', 1); } catch (e) { log.push(`REJECT reg-A again -> ${e.name} ${e.status}: ${e.message}`); }
  await Promise.all(jobs);
  console.log(log.join('\n'));
  console.log('METRICS', JSON.stringify(s.metrics()));
})();
