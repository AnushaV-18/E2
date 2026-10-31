'use strict';
// Shortest-path strategies for E2. Dijkstra is the default; Bellman-Ford is kept for comparison
// (see "Shortest-Path Strategy" in the E2 architecture diagram).

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item, pri) {
    const a = this.a;
    a.push([pri, item]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top; // [priority, item]
  }
}

function checkRoutes(routes) {
  for (const r of routes) {
    if (!Number.isFinite(r.km) || r.km <= 0) throw new Error(`route ${r.from}->${r.to} must have distance_km > 0`);
  }
}

// routes: [{from, to, km}] -> Map(node -> [[neighbour, km], ...])
function buildAdjacency(routes, reverse = false) {
  checkRoutes(routes);
  const adj = new Map();
  for (const { from, to, km } of routes) {
    const [u, v] = reverse ? [to, from] : [from, to];
    if (!adj.has(u)) adj.set(u, []);
    adj.get(u).push([v, km]);
  }
  return adj;
}

// Returns Map(node -> shortest distance from source). Unreachable nodes are absent.
function dijkstra(adj, source) {
  const dist = new Map([[source, 0]]);
  const heap = new MinHeap();
  heap.push(source, 0);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > (dist.get(u) ?? Infinity)) continue; // stale entry
    for (const [v, w] of adj.get(u) || []) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        heap.push(v, nd);
      }
    }
  }
  return dist;
}

function bellmanFord(routes, source, reverse = false) {
  checkRoutes(routes);
  const edges = routes.map(({ from, to, km }) => (reverse ? [to, from, km] : [from, to, km]));
  const nodes = new Set([source]);
  edges.forEach(([u, v]) => { nodes.add(u); nodes.add(v); });
  const dist = new Map([[source, 0]]);
  for (let i = 0; i < nodes.size - 1; i++) {
    let changed = false;
    for (const [u, v, w] of edges) {
      if (dist.has(u) && dist.get(u) + w < (dist.get(v) ?? Infinity)) {
        dist.set(v, dist.get(u) + w);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return dist;
}

// Distance from the customer's region to every reachable region.
function distancesFrom(routes, customerRegionId, direction = 'customer_to_warehouse', strategy = 'dijkstra') {
  const reverse = direction === 'warehouse_to_customer';
  if (strategy === 'bellman-ford') return bellmanFord(routes, customerRegionId, reverse);
  return dijkstra(buildAdjacency(routes, reverse), customerRegionId);
}

module.exports = { MinHeap, buildAdjacency, dijkstra, bellmanFord, distancesFrom };
