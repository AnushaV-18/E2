const express = require("express");
const pool = require("../config/db");
const jwt = require("jsonwebtoken");

const router = express.Router();

// Place an order
router.post("/", async (req, res) => {
    const customer_id = Number(req.body.customer_id);
    const product_id = Number(req.body.product_id);
    const quantity = Number(req.body.quantity);

    if (
        !Number.isInteger(customer_id) ||
        !Number.isInteger(product_id) ||
        !Number.isInteger(quantity) ||
        quantity <= 0
    ) {
        return res.status(400).json({
            message: "Valid customer_id, product_id, and quantity are required."
        });
    }

    // Verify the customer's login token
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ message: "Please log in to place an order." });
    }

    let decoded;
    try {
        decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    } catch (error) {
        return res.status(401).json({ message: "Session expired. Please log in again." });
    }

    // The order must belong to the logged-in customer
    if (decoded.customer_id !== customer_id) {
        return res.status(403).json({
            message: "You can only place orders for your own account."
        });
    }

    let client;

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
            `INSERT INTO orders (customer_id, product_id, quantity, status)
             VALUES ($1, $2, $3, 'CONFIRMED')
             RETURNING order_id, customer_id, product_id, quantity, status`,
            [customer_id, product_id, quantity]
        );

        await client.query("COMMIT");

        return res.status(201).json({
            message: "Order placed successfully!",
            order: orderResult.rows[0]
        });
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Order error:", error.message);
        return res.status(500).json({ message: "Failed to place order." });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;