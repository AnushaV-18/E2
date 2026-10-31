const express = require("express");
const cors = require("cors");
const pool = require("./config/db");
const authRoutes = require("./routes/auth");
const orderRoutes = require("./routes/order");
const fulfilmentRoutes = require("./routes/fulfilment");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/fulfilment", fulfilmentRoutes);

// Test route
app.get("/", (req, res) => {
    res.send("eCart backend is running!");
});

// Get all products with their available stock
app.get("/api/products", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                p.product_id,
                p.product_name,
                p.description,
                p.price,
                i.stock_quantity
            FROM products p
            JOIN inventory i
                ON p.product_id = i.product_id
        `);

        res.json(result.rows);
    } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ message: "Failed to fetch products" });
}
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
