'use strict';
// PostgreSQL implementation of the E2 repo. Column names follow the handbook ER diagram (4.15).
// Note: loadStock reads warehouse_stock.quantity_available and assumes E3 already keeps it net of reservations.

const num = (x) => (x == null ? x : Number(x));

class PgRepo {
  constructor(pool) { this.pool = pool; }
  q(text, params) { return this.pool.query(text, params); }

  async alreadyAllocated(orderId) {
    const r = await this.q('SELECT 1 FROM order_allocation WHERE order_id = $1 LIMIT 1', [orderId]);
    return r.rowCount > 0;
  }

  async loadWarehouses() {
    const r = await this.q('SELECT warehouse_id, region_id, avg_processing_min FROM warehouse');
    return r.rows.map((w) => ({ id: num(w.warehouse_id), regionId: num(w.region_id), processingMin: Number(w.avg_processing_min), active: true }));
  }

  async loadRoutes() {
    const r = await this.q('SELECT from_region_id, to_region_id, distance_km FROM route');
    return r.rows.map((x) => ({ from: num(x.from_region_id), to: num(x.to_region_id), km: Number(x.distance_km) }));
  }

  async loadStock(productIds) {
    const r = await this.q('SELECT warehouse_id, product_id, quantity_available FROM warehouse_stock WHERE product_id = ANY($1::bigint[])', [productIds]);
    const stock = {};
    for (const row of r.rows) {
      const w = num(row.warehouse_id);
      (stock[w] = stock[w] || {})[num(row.product_id)] = Number(row.quantity_available);
    }
    return stock;
  }

  async loadWorkload() {
    const r = await this.q('SELECT warehouse_id, pending_orders FROM e2_workload');
    return Object.fromEntries(r.rows.map((x) => [num(x.warehouse_id), Number(x.pending_orders)]));
  }

  async loadOrder(orderId) {
    const o = await this.q('SELECT order_type, shipping_region_id FROM orders WHERE order_id = $1', [orderId]);
    if (!o.rowCount) return null;
    const d = await this.q('SELECT product_id, SUM(quantity) AS quantity FROM order_details WHERE order_id = $1 GROUP BY product_id', [orderId]);
    return {
      orderId,
      tier: o.rows[0].order_type,
      regionId: num(o.rows[0].shipping_region_id),
      items: d.rows.map((x) => ({ productId: num(x.product_id), quantity: Number(x.quantity) })),
    };
  }

  async savePlans(orderId, round, plans) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      for (const p of plans) {
        for (const part of p.parts) {
          for (const it of part.items) {
            await c.query(
              `INSERT INTO order_allocation (order_id, round_no, plan_rank, warehouse_id, product_id, quantity, eta_min, score, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PLANNED')`,
              [orderId, round, p.rank, part.warehouseId, it.productId, it.quantity, part.etaMin, p.score]);
          }
        }
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async getPlans(orderId) {
    const r = await this.q(
      `SELECT round_no, plan_rank, warehouse_id, product_id, quantity, eta_min, score, status
         FROM order_allocation WHERE order_id = $1 ORDER BY round_no, plan_rank, allocation_id`, [orderId]);
    const plans = new Map();
    for (const row of r.rows) {
      const key = `${row.round_no}:${row.plan_rank}`;
      if (!plans.has(key)) plans.set(key, { round: row.round_no, rank: row.plan_rank, status: row.status, score: row.score == null ? null : Number(row.score), etaMin: 0, parts: [] });
      const plan = plans.get(key);
      const w = num(row.warehouse_id);
      let part = plan.parts.find((p) => p.warehouseId === w);
      if (!part) { part = { warehouseId: w, items: [], etaMin: Number(row.eta_min) }; plan.parts.push(part); }
      part.items.push({ productId: num(row.product_id), quantity: Number(row.quantity) });
      plan.etaMin = Math.max(plan.etaMin, Number(row.eta_min));
    }
    return [...plans.values()];
  }

  async setPlanStatus(orderId, round, rank, status) {
    await this.q('UPDATE order_allocation SET status = $4 WHERE order_id = $1 AND round_no = $2 AND plan_rank = $3', [orderId, round, rank, status]);
  }

  // One shipment per warehouse part. shipment.allocation_id points at the part's first allocation row
  // (the ER keeps one allocation_id per row, so a multi-product part links through its lowest id).
  async createShipments(orderId, round, rank) {
    const r = await this.q(
      `INSERT INTO shipment (order_id, warehouse_id, status, allocation_id)
       SELECT order_id, warehouse_id, 'ALLOCATED', MIN(allocation_id)
         FROM order_allocation WHERE order_id = $1 AND round_no = $2 AND plan_rank = $3
        GROUP BY order_id, warehouse_id
       RETURNING shipment_id, warehouse_id, status`, [orderId, round, rank]);
    return r.rows.map((x) => ({ shipmentId: num(x.shipment_id), warehouseId: num(x.warehouse_id), status: x.status }));
  }

  async getShipments(orderId, round, rank) {
    const r = await this.q(
      `SELECT shipment_id, warehouse_id, status FROM shipment
        WHERE order_id = $1
          AND allocation_id IN (SELECT allocation_id FROM order_allocation WHERE order_id = $1 AND round_no = $2 AND plan_rank = $3)`,
      [orderId, round, rank]);
    return r.rows.map((x) => ({ shipmentId: num(x.shipment_id), warehouseId: num(x.warehouse_id), status: x.status }));
  }

  async setShipmentStatus(shipmentId, status) {
    if (status === 'SHIPPED') await this.q('UPDATE shipment SET status = $2, ship_date = now() WHERE shipment_id = $1', [shipmentId, status]);
    else await this.q('UPDATE shipment SET status = $2 WHERE shipment_id = $1', [shipmentId, status]);
  }

  async logEvent({ orderId, shipmentId = null, warehouseId = null, event, stage = null, note = null }) {
    await this.q('INSERT INTO e2_stage_log (order_id, shipment_id, warehouse_id, event, stage, note) VALUES ($1,$2,$3,$4,$5,$6)',
      [orderId, shipmentId, warehouseId, event, stage, note]);
  }

  async countEvents(shipmentId, event) {
    const r = await this.q('SELECT COUNT(*) AS n FROM e2_stage_log WHERE shipment_id = $1 AND event = $2', [shipmentId, event]);
    return Number(r.rows[0].n);
  }

  async failedWarehouses(orderId) {
    const r = await this.q("SELECT DISTINCT warehouse_id FROM e2_stage_log WHERE order_id = $1 AND event = 'FAILED' AND warehouse_id IS NOT NULL", [orderId]);
    return new Set(r.rows.map((x) => num(x.warehouse_id)));
  }

  async adjustWorkload(warehouseId, delta) {
    await this.q(
      `INSERT INTO e2_workload (warehouse_id, pending_orders) VALUES ($1, GREATEST($2::int, 0))
       ON CONFLICT (warehouse_id) DO UPDATE SET pending_orders = GREATEST(e2_workload.pending_orders + $2::int, 0)`,
      [warehouseId, delta]);
  }

  async stageCounts() {
    const r = await this.q('SELECT status, COUNT(*) AS n FROM shipment GROUP BY status');
    return Object.fromEntries(r.rows.map((x) => [x.status, Number(x.n)]));
  }
}

module.exports = { PgRepo };
