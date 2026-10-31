'use strict';
// E2 business logic: Allocation Service + Fulfilment Service + Recovery & Monitoring Service.
// Depends only on a repo and an e3 client (both injectable), so it can be tested without a database.
const defaults = require('./config');
const { distancesFrom } = require('./graph');
const { buildPlans } = require('./allocator');
const sm = require('./stateMachine');
const { DuplicateError, NotFoundError, BlockedError, ValidationError } = require('./errors');

class E2Service {
  constructor({ repo, e3, cfg = defaults }) {
    this.repo = repo;
    this.e3 = e3;
    this.cfg = cfg;
    this.counters = { allocations: 0, failovers: 0, failures: 0, cancelled: 0, totalLatencyMs: 0 };
  }

  // ---------- Allocation Service ----------
  async allocate(order) {
    const t0 = Date.now();
    if (await this.repo.alreadyAllocated(order.orderId)) {
      throw new DuplicateError(`order ${order.orderId} is already allocated`);
    }
    const planned = await this._planAndSave(order, 1, new Set());
    const result = planned ? await this._next(order.orderId, new Set()) : await this._cancel(order.orderId, 'NO_FEASIBLE_PLAN');
    this.counters.allocations += 1;
    this.counters.totalLatencyMs += Date.now() - t0;
    return result;
  }

  async _planAndSave(order, round, excluded) {
    const [warehouses, routes, workload, stock] = await Promise.all([
      this.repo.loadWarehouses(),
      this.repo.loadRoutes(),
      this.repo.loadWorkload(),
      this.repo.loadStock([...new Set(order.items.map((i) => i.productId))]),
    ]);
    const dist = distancesFrom(routes, order.regionId, this.cfg.routeDirection);
    const plans = buildPlans(order, { warehouses, stock, workload, dist }, { excluded, cfg: this.cfg });
    if (!plans.length) return false;
    await this.repo.savePlans(order.orderId, round, plans);
    return true;
  }

  // Reserve the best remaining plan via E3. If the 3 plans are used up, re-evaluate once; then cancel.
  async _next(orderId, excluded) {
    const plans = await this.repo.getPlans(orderId);
    const round = Math.max(1, ...plans.map((p) => p.round));
    let got = await this._reserveFromRound(orderId, round, excluded);
    if (!got && round < this.cfg.maxRounds) {
      const order = await this.repo.loadOrder(orderId);
      if (order && (await this._planAndSave(order, round + 1, excluded))) {
        got = await this._reserveFromRound(orderId, round + 1, excluded);
      }
    }
    return got ? this._describe(orderId, got) : this._cancel(orderId, 'NO_WAREHOUSE_AVAILABLE');
  }

  async _reserveFromRound(orderId, round, excluded) {
    const plans = (await this.repo.getPlans(orderId))
      .filter((p) => p.round === round && p.status === 'PLANNED')
      .sort((a, b) => a.rank - b.rank);
    for (const plan of plans) {
      if (plan.parts.some((p) => excluded.has(p.warehouseId))) {
        await this.repo.setPlanStatus(orderId, round, plan.rank, 'FAILED');
        continue;
      }
      const res = await this.e3.reserve(orderId, plan);
      if (!res.ok) {
        await this.repo.setPlanStatus(orderId, round, plan.rank, 'FAILED');
        this.counters.failovers += 1;
        continue;
      }
      await this.repo.setPlanStatus(orderId, round, plan.rank, 'RESERVED');
      const shipments = await this.repo.createShipments(orderId, round, plan.rank);
      for (const s of shipments) await this.repo.adjustWorkload(s.warehouseId, +1);
      return { plan, shipments };
    }
    return null;
  }

  async _cancel(orderId, reason) {
    await this.e3.cancelOrder(orderId, reason);
    this.counters.cancelled += 1;
    return { status: 'CANCELLED', orderId, reason };
  }

  _describe(orderId, { plan, shipments }) {
    const shipmentOf = new Map(shipments.map((s) => [s.warehouseId, s.shipmentId]));
    return {
      status: 'ALLOCATED',
      orderId,
      round: plan.round,
      planRank: plan.rank,
      etaMin: plan.etaMin,
      split: plan.parts.length > 1,
      parts: plan.parts.map((p) => ({
        warehouseId: p.warehouseId,
        shipmentId: shipmentOf.get(p.warehouseId),
        items: p.items,
        etaMin: p.etaMin,
      })),
    };
  }

  // ---------- Recovery & Monitoring Service ----------
  // Manual / E3-triggered reallocation, e.g. E3 reports a warehouse cannot supply the stock any more.
  async reallocate({ orderId, warehouseId, reason }) {
    const { plan, shipments } = await this._current(orderId);
    this._assertCanReallocate(shipments);
    if (warehouseId != null) {
      await this.repo.logEvent({ orderId, warehouseId, event: 'FAILED', stage: null, note: reason || 'reallocation requested' });
    }
    return this._failoverFrom(orderId, plan, shipments);
  }

  _assertCanReallocate(shipments, ignoreShipmentId = null) {
    const stages = shipments.filter((s) => s.status !== 'FAILED' && s.shipmentId !== ignoreShipmentId).map((s) => s.status);
    if (!sm.canReallocate(stages)) throw new BlockedError('reallocation blocked: a part is already packed or shipped');
  }

  async _failoverFrom(orderId, plan, shipments) {
    await this.repo.setPlanStatus(orderId, plan.round, plan.rank, 'FAILED');
    for (const s of shipments) {
      if (s.status !== 'FAILED') {
        await this.repo.setShipmentStatus(s.shipmentId, 'FAILED');
        await this.repo.adjustWorkload(s.warehouseId, -1);
      }
    }
    await this.e3.release(orderId, plan); // E3 owns the stock change
    this.counters.failovers += 1;
    return this._next(orderId, await this.repo.failedWarehouses(orderId));
  }

  async _current(orderId) {
    const plan = (await this.repo.getPlans(orderId)).find((p) => p.status === 'RESERVED' || p.status === 'ACTIVE');
    if (!plan) throw new NotFoundError(`order ${orderId} has no active allocation`);
    const shipments = await this.repo.getShipments(orderId, plan.round, plan.rank);
    return { plan, shipments };
  }

  // ---------- Fulfilment Service ----------
  async setStage({ orderId, warehouseId, stage }) {
    const { plan, shipments } = await this._current(orderId);
    const part = shipments.find((s) => s.warehouseId === warehouseId && s.status !== 'FAILED');
    if (!part) throw new NotFoundError(`order ${orderId} has no open part at warehouse ${warehouseId}`);

    if (stage === 'FAILED') return this._partFailed(orderId, plan, shipments, part);

    const t = sm.checkTransition(part.status, stage);
    if (!t.ok) throw new BlockedError(t.error);
    await this.repo.setShipmentStatus(part.shipmentId, stage);
    await this.repo.logEvent({ orderId, shipmentId: part.shipmentId, warehouseId, event: 'STAGE', stage, note: null });
    if (plan.status === 'RESERVED') await this.repo.setPlanStatus(orderId, plan.round, plan.rank, 'ACTIVE');
    if (stage === 'SHIPPED') await this.repo.adjustWorkload(warehouseId, -1);

    const stages = shipments.map((s) => (s.shipmentId === part.shipmentId ? stage : s.status)).filter((s) => s !== 'FAILED');
    return { status: 'OK', orderId, warehouseId, stage, orderShipped: sm.allShipped(stages) };
  }

  // Retry the pick/pack once, then fail the part and move to the next-ranked plan.
  async _partFailed(orderId, plan, shipments, part) {
    if (!sm.failureAllowed(part.status)) throw new BlockedError(`cannot report failure at stage ${part.status}`);
    this._assertCanReallocate(shipments, part.shipmentId);
    const retries = await this.repo.countEvents(part.shipmentId, 'RETRY');
    if (retries < this.cfg.maxRetries) {
      await this.repo.logEvent({ orderId, shipmentId: part.shipmentId, warehouseId: part.warehouseId, event: 'RETRY', stage: part.status, note: null });
      return { status: 'RETRY', orderId, warehouseId: part.warehouseId, stage: part.status };
    }
    await this.repo.logEvent({ orderId, shipmentId: part.shipmentId, warehouseId: part.warehouseId, event: 'FAILED', stage: part.status, note: 'retry exhausted' });
    await this.repo.setShipmentStatus(part.shipmentId, 'FAILED');
    await this.repo.adjustWorkload(part.warehouseId, -1);
    this.counters.failures += 1;
    const refreshed = shipments.map((s) => (s.shipmentId === part.shipmentId ? { ...s, status: 'FAILED' } : s));
    return this._failoverFrom(orderId, plan, refreshed);
  }

  // ---------- Metrics (for the E4 dashboard) ----------
  async metrics() {
    const c = this.counters;
    return {
      allocations: c.allocations,
      failovers: c.failovers,
      partFailures: c.failures,
      cancelled: c.cancelled,
      avgAllocationLatencyMs: c.allocations ? Math.round(c.totalLatencyMs / c.allocations) : 0,
      workload: await this.repo.loadWorkload(),
      shipmentsByStage: await this.repo.stageCounts(),
    };
  }
}

// ---------- request validation (used by the HTTP layer) ----------
const TIERS = new Set(['PLUS', 'REGULAR']);
const isId = (x) => Number.isInteger(x) && x > 0;

function validateAllocate(b) {
  if (!b || typeof b !== 'object') throw new ValidationError('body required');
  if (!isId(b.orderId)) throw new ValidationError('orderId must be a positive integer');
  if (!TIERS.has(b.tier)) throw new ValidationError('tier must be PLUS or REGULAR');
  if (!isId(b.regionId)) throw new ValidationError('regionId must be a positive integer');
  if (!Array.isArray(b.items) || !b.items.length) throw new ValidationError('items must be a non-empty array');
  for (const it of b.items) {
    if (!isId(it && it.productId) || !isId(it && it.quantity)) throw new ValidationError('each item needs positive integer productId and quantity');
  }
  return { orderId: b.orderId, tier: b.tier, regionId: b.regionId, items: b.items.map(({ productId, quantity }) => ({ productId, quantity })) };
}

function validateReallocate(b) {
  if (!b || !isId(b.orderId)) throw new ValidationError('orderId must be a positive integer');
  if (b.warehouseId != null && !isId(b.warehouseId)) throw new ValidationError('warehouseId must be a positive integer');
  return { orderId: b.orderId, warehouseId: b.warehouseId, reason: typeof b.reason === 'string' ? b.reason.slice(0, 200) : undefined };
}

const STAGES = new Set(['PICKED', 'PACKED', 'SHIPPED', 'FAILED']);
function validateStage(orderId, b) {
  if (!isId(orderId)) throw new ValidationError('order id in the path must be a positive integer');
  if (!b || !isId(b.warehouseId)) throw new ValidationError('warehouseId must be a positive integer');
  if (!STAGES.has(b.stage)) throw new ValidationError('stage must be PICKED, PACKED, SHIPPED or FAILED');
  return { orderId, warehouseId: b.warehouseId, stage: b.stage };
}

module.exports = { E2Service, validateAllocate, validateReallocate, validateStage };
