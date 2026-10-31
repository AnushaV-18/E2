'use strict';
// Allocation pipeline (pure functions, no I/O):
//   feasibility filter -> multi-warehouse split (max 3) -> ETA -> Plus/Regular ranking -> top-3 plans.
const defaults = require('./config');

const qty = (stock, wid, pid) => (stock[wid] && stock[wid][pid]) || 0;
const round4 = (x) => Math.round(x * 1e4) / 1e4;

function mergeItems(items) {
  const m = new Map();
  for (const { productId, quantity } of items) m.set(productId, (m.get(productId) || 0) + quantity);
  return m;
}

// ETA (minutes) = travel time + warehouse processing time + queueing delay from pending orders.
function warehouseEta(wh, km, pending, cfg) {
  return (km / cfg.speedKmph) * 60 + wh.processingMin + pending * cfg.workloadMinPerOrder;
}

// Feasibility filter: active, not excluded, reachable on the road graph, and holds at least one ordered product.
function candidates({ warehouses, stock, workload, dist, excluded, wanted, cfg }) {
  return warehouses
    .filter((w) => w.active !== false && !excluded.has(w.id) && dist.has(w.regionId))
    .filter((w) => [...wanted.keys()].some((pid) => qty(stock, w.id, pid) > 0))
    .map((w) => {
      const km = dist.get(w.regionId);
      const pending = workload[w.id] || 0;
      return { id: w.id, km, pending, eta: warehouseEta(w, km, pending, cfg) };
    })
    .sort((a, b) => a.eta - b.eta);
}

function coverage(c, remaining, stock) {
  let total = 0;
  for (const [pid, need] of remaining) total += Math.min(need, qty(stock, c.id, pid));
  return total;
}

// Start from `seed`, then repeatedly add the warehouse covering most of what is still missing (ties: lower ETA).
function greedyPlan(seed, cands, wanted, stock, maxParts) {
  const remaining = new Map(wanted);
  const used = new Set();
  const parts = [];
  let next = seed;
  while (next && parts.length < maxParts) {
    const take = [];
    for (const [pid, need] of remaining) {
      const q = Math.min(need, qty(stock, next.id, pid));
      if (q > 0) take.push({ productId: pid, quantity: q });
    }
    if (!take.length) return null;
    for (const t of take) remaining.set(t.productId, remaining.get(t.productId) - t.quantity);
    used.add(next.id);
    parts.push({ warehouseId: next.id, items: take, km: next.km, etaMin: next.eta, pending: next.pending });
    if ([...remaining.values()].every((v) => v === 0)) return parts;
    let best = null, bestCov = 0;
    for (const c of cands) {
      if (used.has(c.id)) continue;
      const cov = coverage(c, remaining, stock);
      if (cov > bestCov) { best = c; bestCov = cov; }
    }
    next = best;
  }
  return null; // could not cover the order within maxParts warehouses
}

function planMetrics(parts, cfg) {
  const km = parts.reduce((s, p) => s + p.km, 0);
  return {
    parts,
    etaMin: Math.max(...parts.map((p) => p.etaMin)), // parts ship in parallel: order ETA = slowest part
    cost: km * cfg.costPerKm + (parts.length - 1) * cfg.splitPenalty,
    workload: parts.reduce((s, p) => s + p.pending, 0) / parts.length,
  };
}

function rank(plans, tier, cfg) {
  if (tier === 'PLUS') {
    plans.forEach((p) => { p.score = null; });
    return plans.sort((a, b) => a.etaMin - b.etaMin || a.parts.length - b.parts.length || a.cost - b.cost);
  }
  const norm = (key) => {
    const v = plans.map((p) => p[key]);
    const lo = Math.min(...v), hi = Math.max(...v);
    return (p) => (hi === lo ? 0 : (p[key] - lo) / (hi - lo));
  };
  const nEta = norm('etaMin'), nCost = norm('cost'), nLoad = norm('workload');
  const w = cfg.weights;
  plans.forEach((p) => { p.score = round4(w.eta * nEta(p) + w.cost * nCost(p) + w.workload * nLoad(p)); });
  return plans.sort((a, b) => a.score - b.score || a.etaMin - b.etaMin);
}

/**
 * order:   { tier: 'PLUS'|'REGULAR', items: [{productId, quantity}] }
 * context: { warehouses:[{id, regionId, processingMin, active}], stock:{wid:{pid:qty}},
 *            workload:{wid:pending}, dist: Map(regionId -> km) }
 * Returns up to cfg.topN plans: [{rank, status:'PLANNED', etaMin, cost, score, parts:[{warehouseId, items, etaMin, km}]}]
 */
function buildPlans(order, context, { excluded = new Set(), cfg = defaults } = {}) {
  const wanted = mergeItems(order.items);
  const cands = candidates({ ...context, excluded, wanted, cfg });
  const seen = new Set();
  const plans = [];
  for (const seed of cands) {
    const parts = greedyPlan(seed, cands, wanted, context.stock, cfg.maxParts);
    if (!parts) continue;
    const key = parts.map((p) => p.warehouseId).sort((a, b) => a - b).join('+');
    if (seen.has(key)) continue; // same warehouse set already planned
    seen.add(key);
    plans.push(planMetrics(parts, cfg));
  }
  const ranked = rank(plans, order.tier, cfg).slice(0, cfg.topN);
  return ranked.map((p, i) => ({
    rank: i + 1,
    status: 'PLANNED',
    etaMin: Math.ceil(p.etaMin),
    cost: p.cost,
    score: p.score,
    parts: p.parts.map(({ warehouseId, items, etaMin, km }) => ({ warehouseId, items, etaMin: Math.ceil(etaMin), km })),
  }));
}

module.exports = { buildPlans, warehouseEta, mergeItems };
