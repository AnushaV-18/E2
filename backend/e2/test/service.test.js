'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { E2Service, validateAllocate, validateStage } = require('../service');
const { DuplicateError, BlockedError, ValidationError } = require('../errors');
const { cfg, MemoryRepo, fakeE3, fullStock } = require('./helpers');

const ORDER = { orderId: 1, tier: 'PLUS', regionId: 1, items: [{ productId: 100, quantity: 5 }] };
const setup = (e3opts, repoOpts = {}) => {
  const repo = new MemoryRepo({ stock: fullStock, order: ORDER, ...repoOpts });
  const e3 = fakeE3(e3opts);
  return { repo, e3, svc: new E2Service({ repo, e3, cfg }) };
};

test('allocate reserves the best plan via E3 and creates a shipment per part', async () => {
  const { svc, e3, repo } = setup();
  const r = await svc.allocate(ORDER);
  assert.equal(r.status, 'ALLOCATED');
  assert.equal(r.planRank, 1);
  assert.equal(r.parts[0].warehouseId, 2);         // B has the earliest ETA
  assert.equal(r.etaMin, 25);
  assert.equal(e3.calls.reserve.length, 1);
  assert.equal(repo.plans.length, 3);               // top-3 stored
  assert.equal(repo.plans[0].status, 'RESERVED');
  assert.equal(repo.workload[2], 1);                // pending counter incremented
});

test('the same order cannot be allocated twice', async () => {
  const { svc } = setup();
  await svc.allocate(ORDER);
  await assert.rejects(() => svc.allocate(ORDER), DuplicateError);
});

test('full flow: pick -> pack -> ship updates stages, plan status and workload', async () => {
  const { svc, repo } = setup();
  await svc.allocate(ORDER);
  await svc.setStage({ orderId: 1, warehouseId: 2, stage: 'PICKED' });
  assert.equal(repo.plans[0].status, 'ACTIVE');
  await svc.setStage({ orderId: 1, warehouseId: 2, stage: 'PACKED' });
  const done = await svc.setStage({ orderId: 1, warehouseId: 2, stage: 'SHIPPED' });
  assert.equal(done.orderShipped, true);
  assert.equal(repo.workload[2], 0);
});

test('invalid stage jumps are rejected', async () => {
  const { svc } = setup();
  await svc.allocate(ORDER);
  await assert.rejects(() => svc.setStage({ orderId: 1, warehouseId: 2, stage: 'SHIPPED' }), BlockedError);
});

test('pick failure: first report retries, second fails over to the next-ranked warehouse', async () => {
  const { svc, e3, repo } = setup();
  await svc.allocate(ORDER);
  const first = await svc.setStage({ orderId: 1, warehouseId: 2, stage: 'FAILED' });
  assert.equal(first.status, 'RETRY');
  const second = await svc.setStage({ orderId: 1, warehouseId: 2, stage: 'FAILED' });
  assert.equal(second.status, 'ALLOCATED');
  assert.equal(second.planRank, 2);
  assert.equal(second.parts[0].warehouseId, 1);     // A is next (ETA 30)
  assert.equal(e3.calls.release.length, 1);         // E3 asked to free the failed plan's reservation
  assert.equal(repo.plans.find((p) => p.rank === 1).status, 'FAILED');
  assert.equal(repo.workload[2], 0);
  assert.equal(repo.workload[1], 1);
});

test('failed warehouses are skipped for the rest of the order', async () => {
  const { svc } = setup();
  await svc.allocate(ORDER);
  await svc.reallocate({ orderId: 1, warehouseId: 2, reason: 'stock mismatch' }); // -> A
  const r = await svc.reallocate({ orderId: 1, warehouseId: 1 });                  // -> C
  assert.equal(r.parts[0].warehouseId, 3);
});

test('reallocation is blocked once the part is packed', async () => {
  const { svc } = setup();
  await svc.allocate(ORDER);
  await svc.setStage({ orderId: 1, warehouseId: 2, stage: 'PICKED' });
  await svc.setStage({ orderId: 1, warehouseId: 2, stage: 'PACKED' });
  await assert.rejects(() => svc.reallocate({ orderId: 1, warehouseId: 2 }), BlockedError);
  await assert.rejects(() => svc.setStage({ orderId: 1, warehouseId: 2, stage: 'FAILED' }), BlockedError);
});

test('when E3 rejects a plan, the next plan is tried; if all 3 fail the order is re-evaluated once, then cancelled', async () => {
  const { svc, e3, repo } = setup({ reserveOk: () => false });
  const r = await svc.allocate(ORDER);
  assert.equal(r.status, 'CANCELLED');
  assert.equal(e3.calls.reserve.length, 6);         // 3 plans in round 1 + 3 in the re-evaluated round 2
  assert.deepEqual([...new Set(repo.plans.map((p) => p.round))], [1, 2]);
  assert.equal(e3.calls.cancel.length, 1);
});

test('no feasible plan (not enough stock anywhere) cancels the order', async () => {
  const { svc, e3 } = setup();
  const r = await svc.allocate({ ...ORDER, items: [{ productId: 100, quantity: 9999 }] });
  assert.equal(r.status, 'CANCELLED');
  assert.equal(e3.calls.cancel[0].reason, 'NO_FEASIBLE_PLAN');
});

test('split order: parts progress independently and the order ships when all parts ship', async () => {
  const stock = { 1: { 100: 6 }, 2: { 100: 6 }, 3: { 100: 0 } };
  const { svc } = setup({}, { stock });
  const r = await svc.allocate({ ...ORDER, items: [{ productId: 100, quantity: 10 }] });
  assert.equal(r.split, true);
  assert.equal(r.parts.length, 2);
  const [a, b] = r.parts.map((p) => p.warehouseId);
  for (const w of [a, b]) {
    await svc.setStage({ orderId: 1, warehouseId: w, stage: 'PICKED' });
    await svc.setStage({ orderId: 1, warehouseId: w, stage: 'PACKED' });
  }
  assert.equal((await svc.setStage({ orderId: 1, warehouseId: a, stage: 'SHIPPED' })).orderShipped, false);
  assert.equal((await svc.setStage({ orderId: 1, warehouseId: b, stage: 'SHIPPED' })).orderShipped, true);
});

test('metrics report allocations, failovers and workload', async () => {
  const { svc } = setup();
  await svc.allocate(ORDER);
  await svc.reallocate({ orderId: 1, warehouseId: 2 });
  const m = await svc.metrics();
  assert.equal(m.allocations, 1);
  assert.equal(m.failovers, 1);
  assert.equal(m.workload[1], 1);
});

test('request validation', () => {
  assert.throws(() => validateAllocate({ orderId: 1, tier: 'GOLD', regionId: 1, items: [{ productId: 1, quantity: 1 }] }), ValidationError);
  assert.throws(() => validateAllocate({ orderId: 1, tier: 'PLUS', regionId: 1, items: [] }), ValidationError);
  assert.throws(() => validateAllocate({ orderId: 1, tier: 'PLUS', regionId: 1, items: [{ productId: 1, quantity: 0 }] }), ValidationError);
  assert.throws(() => validateStage(1, { warehouseId: 1, stage: 'DELIVERED' }), ValidationError);
  assert.deepEqual(validateAllocate({ orderId: 1, tier: 'REGULAR', regionId: 2, items: [{ productId: 3, quantity: 4, extra: 'x' }] }).items, [{ productId: 3, quantity: 4 }]);
});
