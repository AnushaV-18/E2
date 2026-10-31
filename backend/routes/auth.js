const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const router = express.Router();

// Customer Registration
router.post("/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({
                message: "Name, email, and password are required."
            });
        }

        const existingCustomer = await pool.query(
            "SELECT customer_id FROM customers WHERE email = $1",
            [email]
        );

        if (existingCustomer.rows.length > 0) {
            return res.status(409).json({
                message: "Email is already registered."
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `INSERT INTO customers (name, email, password_hash)
             VALUES ($1, $2, $3)
             RETURNING customer_id, name, email`,
            [name, email, passwordHash]
        );

        res.status(201).json({
            message: "Registration successful!",
            customer: result.rows[0]
        });
    } catch (error) {
        console.error("Registration error:", error.message);

        res.status(500).json({
            message: "Registration failed."
        });
    }
});

// Customer Login
router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                message: "Email and password are required."
            });
        }

        const result = await pool.query(
            "SELECT * FROM customers WHERE email = $1",
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                message: "Invalid email or password."
            });
        }

        const customer = result.rows[0];

        const passwordMatches = await bcrypt.compare(
            password,
            customer.password_hash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                message: "Invalid email or password."
            });
        }

        const token = jwt.sign(
            {
                customer_id: customer.customer_id,
                email: customer.email
            },
            process.env.JWT_SECRET,
            { expiresIn: "2h" }
        );

        res.json({
            message: "Login successful!",
            token,
            customer: {
                customer_id: customer.customer_id,
                name: customer.name,
                email: customer.email
            }
        });
    } catch (error) {
        console.error("Login error:", error.message);

        res.status(500).json({
            message: "Login failed."
        });
    }
});

module.exports = router;