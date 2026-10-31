const express = require("express");
const pool = require("../config/db");
const jwt = require("jsonwebtoken");
const e2 = require("../e2");

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

// Place an order, then let the E2 engine pick the warehouse(s)
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
            return res.status(404).json({ message: "Product not found." });
        }

        if (inventoryResult.rows[0].stock_quantity < quantity) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                message: "Sorry, not enough stock for this product."
            });
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
        return res.status(500).json({ message: "Failed to place order." });
    } finally {
        if (client) client.release();
    }

    // The order is saved. Now E2 chooses the warehouse(s).
    try {
        const allocation = await e2.allocate({
            orderId: order.order_id,
            tier,
            regionId: region_id,
            items: [{ productId: product_id, quantity }]
        });

        if (allocation.status !== "ALLOCATED") {
            // E3 already cancelled the order and gave the stock back
            return res.status(409).json({
                message: "Sorry, no warehouse could supply this order. It was cancelled."
            });
        }

        await pool.query("UPDATE orders SET status = 'ALLOCATED' WHERE order_id = $1", [order.order_id]);
        order.status = "ALLOCATED";

        return res.status(201).json({
            message: "Order placed successfully!",
            order,
            allocation
        });
    } catch (error) {
        console.error("Allocation error:", error.message);
        return res.status(201).json({
            message: "Order placed. Warehouse allocation is pending.",
            order,
            allocation: null
        });
    }
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
