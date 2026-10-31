const { Pool } = require("pg");
require("dotenv").config();

const url = process.env.DATABASE_URL || "";

if (!url) {
    console.error(
        "\n*** DATABASE_URL is missing. ***\n" +
        "Create the file backend/.env (not .env.txt) next to server.js and put your DATABASE_URL in it.\n" +
        "Then stop the server (Ctrl+C) and run npm start again.\n"
    );
}

// Local PostgreSQL has no SSL; hosted databases (Render, etc.) need it.
// You can force it either way with DATABASE_SSL=false or DATABASE_SSL=true in .env
const isLocal = /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/.test(url);
const forced = (process.env.DATABASE_SSL || "").trim().toLowerCase();
const useSsl = forced ? forced === "true" : !isLocal;

const pool = new Pool({
    connectionString: url,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
});

pool.on("connect", () => {
    console.log("Connected to PostgreSQL");
});

pool.on("error", (err) => {
    console.error("Unexpected PostgreSQL error:", err);
});

module.exports = pool;