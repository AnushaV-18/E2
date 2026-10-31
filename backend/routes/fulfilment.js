const express = require("express");
const crypto = require("crypto");
const pool = require("../config/db");
const e2 = require("../e2");
const { validateReallocate, validateStage } = require("../e2/service");
const { AppError } = require("../e2/errors");

const router = express.Router();

// Warehouse staff only: send  Authorization: Bearer <E2_TOKEN from backend/.env>
router.use((req, res, next) => {
    const expected = process.env.E2_TOKEN;
    if (!expected) {
        return res.status(503).json({ message: "Set E2_TOKEN in backend/.env first." });
    }
    const given = Buffer.from((req.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(expected);
    if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
    return res.status(401).json({ message: "Unauthorized." });
});

const wrap = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        if (err instanceof AppError) return res.status(err.status).json({ message: err.message });
        console.error("Fulfilment error:", err);
        res.status(500).json({ message: "Internal error." });
    }
};

// Move a warehouse's part of an order: PICKED -> PACKED -> SHIPPED (or FAILED)
router.put("/orders/:id/stage", wrap(async (req, res) => {
    const result = await e2.setStage(validateStage(Number(req.params.id), req.body));
    if (result.orderShipped) {
        await pool.query("UPDATE orders SET status = 'SHIPPED' WHERE order_id = $1", [Number(req.params.id)]);
    }
    res.json(result);
}));

router.post("/reallocate", wrap(async (req, res) => {
    res.json(await e2.reallocate(validateReallocate(req.body)));
}));

router.get("/metrics", wrap(async (req, res) => {
    res.json(await e2.metrics());
}));

module.exports = router;
