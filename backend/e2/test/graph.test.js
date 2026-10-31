'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAdjacency, dijkstra, bellmanFord, distancesFrom } = require('../graph');
const { routes } = require('./helpers');

test('dijkstra finds the shortcut 1->2->3 (15) instead of the direct edge (30)', () => {
  const d = dijkstra(buildAdjacency(routes), 1);
  assert.equal(d.get(1), 0);
  assert.equal(d.get(2), 10);
  assert.equal(d.get(3), 15);
  assert.equal(d.get(4), 50);
});

test('bellman-ford agrees with dijkstra', () => {
  const a = dijkstra(buildAdjacency(routes), 1);
  const b = bellmanFord(routes, 1);
  assert.deepEqual([...a].sort(), [...b].sort());
});

test('unreachable regions are absent from the result', () => {
  const d = distancesFrom([{ from: 1, to: 2, km: 5 }, { from: 8, to: 9, km: 1 }], 1);
  assert.equal(d.has(9), false);
});

test('direction option follows edges the other way', () => {
  const one = [{ from: 2, to: 1, km: 7 }]; // only warehouse-region 2 -> customer-region 1
  assert.equal(distancesFrom(one, 1, 'customer_to_warehouse').has(2), false);
  assert.equal(distancesFrom(one, 1, 'warehouse_to_customer').get(2), 7);
});

test('non-positive distances are rejected', () => {
  assert.throws(() => buildAdjacency([{ from: 1, to: 2, km: 0 }]), /distance_km > 0/);
});
