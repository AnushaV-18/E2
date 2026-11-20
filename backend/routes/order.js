const express = require("express");
const pool = require("../config/db");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const e2 = require("../e2");
const scheduler = require("../e1");
const { RetryableError } = require("../e1/errors");

const router = express.Router();

function getCustomer(req, res) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({ message: "Please log in." });
        return null;
    }
    try {
        return jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    } catch (error) {
        res.status(401).json({ message: "Session expired. Please log in again." });
        return null;
    }
}

// ---- the work for ONE order (runs inside an E1 worker) ----
// Returns { status, body } for the HTTP reply. It throws RetryableError only while nothing is committed yet.
async function placeOrder({ customer_id, product_id, quantity, region_id, tier }) {
    let client;
    let order;

    try {
        client = await pool.connect();
        await client.query("BEGIN");

        // Lock this product's inventory row so two buyers can't oversell it
        const inventoryResult = await client.query(
            `SELECT stock_quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
            [product_id]
        );

        if (inventoryResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return { status: 404, body: { message: "Product not found." } };
        }

        if (inventoryResult.rows[0].stock_quantity < quantity) {
            await client.query("ROLLBACK");
            return { status: 409, body: { message: "Sorry, not enough stock for this product." } };
        }

        await client.query(
            `UPDATE inventory
             SET stock_quantity = stock_quantity - $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE product_id = $2`,
            [quantity, product_id]
        );

        const orderResult = await client.query(
            `INSERT INTO orders (customer_id, product_id, quantity, status, order_type, shipping_region_id)
             VALUES ($1, $2, $3, 'CONFIRMED', $4, $5)
             RETURNING order_id, customer_id, product_id, quantity, status, order_type`,
            [customer_id, product_id, quantity, tier, region_id]
        );
        order = orderResult.rows[0];

        await client.query(
            `INSERT INTO order_details (order_id, product_id, quantity) VALUES ($1, $2, $3)`,
            [order.order_id, product_id, quantity]
        );

        await client.query("COMMIT");
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Order error:", error.message);
        // Nothing was committed, so the scheduler may safely try this order once more.
        throw new RetryableError("order transaction failed", error);
    } finally {
        if (client) client.release();
    }

    // The order is saved (committed). From here on we never retry. Now E2 chooses the warehouse(s).
    try {
        const allocation = await e2.allocate({
            orderId: order.order_id,
            tier,
            regionId: region_id,
            items: [{ productId: product_id, quantity }]
        });

        if (allocation.status !== "ALLOCATED") {
            // E3 already cancelled the order and gave the stock back
            return { status: 409, body: { message: "Sorry, no warehouse could supply this order. It was cancelled." } };
        }

        await pool.query("UPDATE orders SET status = 'ALLOCATED' WHERE order_id = $1", [order.order_id]);
        order.status = "ALLOCATED";

        return { status: 201, body: { message: "Order placed successfully!", order, allocation } };
    } catch (error) {
        console.error("Allocation error:", error.message);
        return { status: 201, body: { message: "Order placed. Warehouse allocation is pending.", order, allocation: null } };
    }
}

// Place an order: validate, then hand it to the E1 scheduler (queue -> worker -> placeOrder)
router.post("/", async (req, res) => {
    const customer_id = Number(req.body.customer_id);
    const product_id = Number(req.body.product_id);
    const quantity = Number(req.body.quantity);
    const region_id = req.body.region_id === undefined ? 4 : Number(req.body.region_id);
    const tier = req.body.tier === "PLUS" ? "PLUS" : "REGULAR";

    if (
        !Number.isInteger(customer_id) ||
        !Number.isInteger(product_id) ||
        !Number.isInteger(quantity) ||
        !Number.isInteger(region_id) ||
        quantity <= 0
    ) {
        return res.status(400).json({
            message: "Valid customer_id, product_id, and quantity are required."
        });
    }

    const decoded = getCustomer(req, res);
    if (!decoded) return;

    if (decoded.customer_id !== customer_id) {
        return res.status(403).json({
            message: "You can only place orders for your own account."
        });
    }

    // The client sends one request_id per order click; a repeat (double click, retry) is rejected.
    const requestId = String(req.body.request_id || req.get("Idempotency-Key") || crypto.randomUUID());

    try {
        const out = await scheduler.submit({
            requestId,
            tier,
            key: `product:${product_id}`,   // orders for the same product never run at the same time
            run: () => placeOrder({ customer_id, product_id, quantity, region_id, tier })
        });
        return res.status(out.status).json({ ...out.body, request_id: requestId });
    } catch (error) {
        if (error && error.status) {
            if (error.status === 503) res.set("Retry-After", "2");
            return res.status(error.status).json({ message: error.message });
        }
        console.error("Order scheduling error:", error.message);
        return res.status(500).json({ message: "Failed to place order." });
    }
});

// Processing status of one order request: QUEUED, RUNNING, DONE, FAILED or UNKNOWN
router.get("/status/:requestId", (req, res) => {
    if (!getCustomer(req, res)) return;
    res.json({ request_id: req.params.requestId, status: scheduler.status(req.params.requestId) });
});

// E1 queue / worker metrics for the dashboard (staff only: Bearer E2_TOKEN)
router.get("/metrics", (req, res) => {
    const expected = process.env.E2_TOKEN;
    if (!expected) return res.status(503).json({ message: "Set E2_TOKEN in backend/.env first." });
    const given = Buffer.from((req.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(expected);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        return res.status(401).json({ message: "Unauthorized." });
    }
    res.json(scheduler.metrics());
});

// The logged-in customer's orders with their shipments
router.get("/mine", async (req, res) => {
    const decoded = getCustomer(req, res);
    if (!decoded) return;

    try {
        const result = await pool.query(
            `SELECT o.order_id, o.product_id, p.product_name, o.quantity, o.status, o.order_type, o.created_at,
                    COALESCE(
                      json_agg(json_build_object(
                        'shipment_id', s.shipment_id,
                        'warehouse_id', s.warehouse_id,
                        'warehouse_name', w.name,
                        'status', s.status
                      ) ORDER BY s.shipment_id) FILTER (WHERE s.shipment_id IS NOT NULL AND s.status <> 'FAILED'),
                      '[]'::json) AS shipments
               FROM orders o
               JOIN products p ON p.product_id = o.product_id
               LEFT JOIN shipment s ON s.order_id = o.order_id
               LEFT JOIN warehouse w ON w.warehouse_id = s.warehouse_id
              WHERE o.customer_id = $1
              GROUP BY o.order_id, p.product_name
              ORDER BY o.order_id DESC
              LIMIT 20`,
            [decoded.customer_id]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("My orders error:", error.message);
        res.status(500).json({ message: "Could not load your orders." });
    }
});

module.exports = router;
