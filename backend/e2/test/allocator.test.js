'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlans } = require('../allocator');
const { distancesFrom } = require('../graph');
const { cfg, routes, warehouses, fullStock } = require('./helpers');

const dist = distancesFrom(routes, 1);
const ctx = (over = {}) => ({ warehouses, stock: fullStock, workload: {}, dist, ...over });
const order = (tier, items = [{ productId: 100, quantity: 5 }]) => ({ tier, items });

test('Plus: plans are ranked by earliest ETA (B 25, A 30, C 55)', () => {
  const plans = buildPlans(order('PLUS'), ctx(), { cfg });
  assert.deepEqual(plans.map((p) => p.parts[0].warehouseId), [2, 1, 3]);
  assert.deepEqual(plans.map((p) => p.etaMin), [25, 30, 55]);
  assert.ok(plans.every((p) => p.score === null));
});

test('keeps at most 3 plans, numbered 1..3, all PLANNED', () => {
  const plans = buildPlans(order('REGULAR'), ctx(), { cfg });
  assert.deepEqual(plans.map((p) => p.rank), [1, 2, 3]);
  assert.ok(plans.every((p) => p.status === 'PLANNED'));
});

test('workload delays the ETA and can change the Plus winner', () => {
  // B has 10 pending orders: +20 min -> ETA 45, so A (30) now wins
  const plans = buildPlans(order('PLUS'), ctx({ workload: { 2: 10 } }), { cfg });
  assert.equal(plans[0].parts[0].warehouseId, 1);
  assert.equal(plans.find((p) => p.parts[0].warehouseId === 2).etaMin, 45);
});

test('Regular uses the weighted score, so it can differ from Plus', () => {
  const wh = [
    { id: 1, regionId: 2, processingMin: 0, active: true },  // X: 20 km, ETA 20, cost 20
    { id: 2, regionId: 3, processingMin: 15, active: true }, // Y: 10 km, ETA 25, cost 10
  ];
  const r = [[1, 2, 20], [1, 3, 10]].map(([from, to, km]) => ({ from, to, km }));
  const c = { warehouses: wh, stock: { 1: { 100: 9 }, 2: { 100: 9 } }, workload: {}, dist: distancesFrom(r, 1) };
  assert.equal(buildPlans(order('PLUS'), c, { cfg })[0].parts[0].warehouseId, 1);
  const costHeavy = { ...cfg, weights: { eta: 0.2, cost: 0.6, workload: 0.2 } };
  const regular = buildPlans(order('REGULAR'), c, { cfg: costHeavy });
  assert.equal(regular[0].parts[0].warehouseId, 2);
  assert.ok(regular[0].score < regular[1].score); // lower score is better
});

test('splits across warehouses when none can fill the order alone', () => {
  const stock = { 1: { 100: 6 }, 2: { 100: 6 }, 3: { 100: 0 } };
  const plans = buildPlans(order('PLUS', [{ productId: 100, quantity: 10 }]), ctx({ stock }), { cfg });
  assert.equal(plans.length, 1);
  const p = plans[0];
  assert.equal(p.parts.length, 2);
  assert.equal(p.parts.reduce((s, x) => s + x.items[0].quantity, 0), 10);
  assert.equal(p.etaMin, 30); // parallel parts: slowest part (A, 30) sets the ETA
});

test('never splits across more than 3 warehouses', () => {
  const stock = { 1: { 100: 3 }, 2: { 100: 3 }, 3: { 100: 3 } };
  const need = (q) => buildPlans(order('PLUS', [{ productId: 100, quantity: q }]), ctx({ stock }), { cfg });
  assert.equal(need(9).length, 1);   // exactly 3 warehouses
  assert.equal(need(10).length, 0);  // would need more stock than exists
  const cfg2 = { ...cfg, maxParts: 2 };
  assert.equal(buildPlans(order('PLUS', [{ productId: 100, quantity: 9 }]), ctx({ stock }), { cfg: cfg2 }).length, 0);
});

test('multi-product orders are covered per product', () => {
  const stock = { 1: { 100: 5, 200: 0 }, 2: { 100: 0, 200: 5 }, 3: { 100: 0, 200: 0 } };
  const items = [{ productId: 100, quantity: 5 }, { productId: 200, quantity: 5 }];
  const plans = buildPlans(order('PLUS', items), ctx({ stock }), { cfg });
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].parts.map((p) => p.warehouseId).sort(), [1, 2]);
});

test('excluded warehouses never appear in any plan', () => {
  const plans = buildPlans(order('PLUS'), ctx(), { cfg, excluded: new Set([2]) });
  assert.ok(plans.every((p) => p.parts.every((x) => x.warehouseId !== 2)));
  assert.equal(plans.length, 2);
});

test('no plan when stock is insufficient everywhere, or warehouses are unreachable', () => {
  assert.deepEqual(buildPlans(order('PLUS', [{ productId: 100, quantity: 500 }]), ctx(), { cfg }), []);
  assert.deepEqual(buildPlans(order('PLUS'), ctx({ dist: new Map([[1, 0]]) }), { cfg }), []);
});

test('duplicate product lines are merged', () => {
  const stock = { 1: { 100: 8 }, 2: { 100: 0 }, 3: { 100: 0 } };
  const items = [{ productId: 100, quantity: 5 }, { productId: 100, quantity: 5 }];
  assert.equal(buildPlans(order('PLUS', items), ctx({ stock }), { cfg }).length, 0); // 10 needed, only 8 exist
});
