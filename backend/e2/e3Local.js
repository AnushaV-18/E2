'use strict';
// "E3" (stock & order manager) implemented inside this backend.
// E2 asks it to reserve / release warehouse stock and to cancel orders.
// E2 reads and writes the warehouse_stock table; ecart's own `inventory` (total stock shown in the shop) is separate.

function createLocalE3(pool) {
  const items = (plan) => plan.parts.flatMap((p) => p.items.map((i) => ({ warehouseId: p.warehouseId, ...i })));

  // Take the stock of a plan out of the warehouses. All-or-nothing.
  async function reserve(orderId, plan) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const it of items(plan)) {
        const r = await client.query(
          `UPDATE warehouse_stock SET quantity_available = quantity_available - $1
            WHERE warehouse_id = $2 AND product_id = $3 AND quantity_available >= $1`,
          [it.quantity, it.warehouseId, it.productId]);
        if (r.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false }; }
      }
      await client.query('COMMIT');
      return { ok: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('E3 reserve error:', err.message);
      return { ok: false, error: err.message };
    } finally {
      client.release();
    }
  }

  // Put the stock of a failed plan back.
  async function release(orderId, plan) {
    try {
      for (const it of items(plan)) {
        await pool.query(
          `UPDATE warehouse_stock SET quantity_available = quantity_available + $1
            WHERE warehouse_id = $2 AND product_id = $3`,
          [it.quantity, it.warehouseId, it.productId]);
      }
      return { ok: true };
    } catch (err) {
      console.error('E3 release error:', err.message);
      return { ok: false, error: err.message };
    }
  }

  // Cancel the order and give the stock back to the shop's total inventory.
  async function cancelOrder(orderId, reason) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const u = await client.query(
        "UPDATE orders SET status = 'CANCELLED' WHERE order_id = $1 AND status <> 'CANCELLED' RETURNING order_id", [orderId]);
      if (u.rowCount === 1) {
        await client.query(
          `UPDATE inventory i SET stock_quantity = i.stock_quantity + d.quantity, updated_at = CURRENT_TIMESTAMP
             FROM order_details d WHERE d.order_id = $1 AND i.product_id = d.product_id`, [orderId]);
      }
      await client.query('COMMIT');
      console.log(`Order ${orderId} cancelled (${reason})`);
      return { ok: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('E3 cancel error:', err.message);
      return { ok: false, error: err.message };
    } finally {
      client.release();
    }
  }

  return { reserve, release, cancelOrder };
}

module.exports = { createLocalE3 };
