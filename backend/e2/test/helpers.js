'use strict';
// Test fixtures: 3 warehouses around customer region 1, and an in-memory repo with the same interface as PgRepo.
const cfg = { ...require('../config'), speedKmph: 60 }; // 60 km/h => 1 km = 1 minute, easy to reason about

// regions: 1 = customer, 2/3/4 = warehouses A/B/C. 2<->3 is a shortcut: 1->2->3 = 15 km, cheaper than the direct 30 km.
const routes = [
  [1, 2, 10], [2, 1, 10], [1, 3, 30], [3, 1, 30], [1, 4, 50], [4, 1, 50], [2, 3, 5], [3, 2, 5],
].map(([from, to, km]) => ({ from, to, km }));

const warehouses = [
  { id: 1, regionId: 2, processingMin: 20, active: true }, // A: 10 km -> ETA 30
  { id: 2, regionId: 3, processingMin: 10, active: true }, // B: 15 km via A -> ETA 25
  { id: 3, regionId: 4, processingMin: 5, active: true },  // C: 50 km -> ETA 55
];

class MemoryRepo {
  constructor({ stock, workload = {}, order = null } = {}) {
    this.stock = stock;
    this.workload = { ...workload };
    this.order = order;
    this.plans = [];      // flat: {orderId, round, rank, status, score, etaMin, parts}
    this.shipments = [];  // {shipmentId, orderId, round, rank, warehouseId, status}
    this.log = [];
    this.nextShipment = 1;
  }
  async alreadyAllocated(orderId) { return this.plans.some((p) => p.orderId === orderId); }
  async loadWarehouses() { return warehouses; }
  async loadRoutes() { return routes; }
  async loadStock() { return this.stock; }
  async loadWorkload() { return { ...this.workload }; }
  async loadOrder() { return this.order; }
  async savePlans(orderId, round, plans) {
    for (const p of plans) this.plans.push({ orderId, round, rank: p.rank, status: 'PLANNED', score: p.score, etaMin: p.etaMin, parts: p.parts });
  }
  async getPlans(orderId) { return this.plans.filter((p) => p.orderId === orderId); }
  async setPlanStatus(orderId, round, rank, status) {
    this.plans.find((p) => p.orderId === orderId && p.round === round && p.rank === rank).status = status;
  }
  async createShipments(orderId, round, rank) {
    const plan = this.plans.find((p) => p.orderId === orderId && p.round === round && p.rank === rank);
    return plan.parts.map((part) => {
      const s = { shipmentId: this.nextShipment++, orderId, round, rank, warehouseId: part.warehouseId, status: 'ALLOCATED' };
      this.shipments.push(s);
      return { ...s };
    });
  }
  async getShipments(orderId, round, rank) {
    return this.shipments.filter((s) => s.orderId === orderId && s.round === round && s.rank === rank).map((s) => ({ ...s }));
  }
  async setShipmentStatus(id, status) { this.shipments.find((s) => s.shipmentId === id).status = status; }
  async logEvent(e) { this.log.push(e); }
  async countEvents(shipmentId, event) { return this.log.filter((e) => e.shipmentId === shipmentId && e.event === event).length; }
  async failedWarehouses(orderId) {
    return new Set(this.log.filter((e) => e.orderId === orderId && e.event === 'FAILED' && e.warehouseId != null).map((e) => e.warehouseId));
  }
  async adjustWorkload(w, d) { this.workload[w] = Math.max(0, (this.workload[w] || 0) + d); }
  async stageCounts() {
    const out = {};
    for (const s of this.shipments) out[s.status] = (out[s.status] || 0) + 1;
    return out;
  }
}

function fakeE3({ reserveOk = () => true } = {}) {
  const calls = { reserve: [], release: [], cancel: [] };
  return {
    calls,
    reserve: async (orderId, plan) => { calls.reserve.push({ orderId, rank: plan.rank, round: plan.round }); return { ok: reserveOk(plan, calls) }; },
    release: async (orderId, plan) => { calls.release.push({ orderId, rank: plan.rank }); return { ok: true }; },
    cancelOrder: async (orderId, reason) => { calls.cancel.push({ orderId, reason }); return { ok: true }; },
  };
}

const fullStock = { 1: { 100: 50 }, 2: { 100: 50 }, 3: { 100: 50 } };
module.exports = { cfg, routes, warehouses, MemoryRepo, fakeE3, fullStock };
