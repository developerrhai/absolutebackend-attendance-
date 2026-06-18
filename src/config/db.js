const mysql = require("mysql2/promise");
require("dotenv").config();

let pool = null;

/**
 * Returns a singleton MySQL connection pool.
 * Reads DATABASE_URL first; falls back to individual DB_* env vars.
 */
function getPool() {
  if (pool) return pool;

  const url = process.env.DATABASE_URL;

  if (url) {
    pool = mysql.createPool(url + "?dateStrings=true");
  } else {
    pool = mysql.createPool({
      host:     process.env.DB_HOST     || "localhost",
      port:     Number(process.env.DB_PORT || 3306),
      user:     process.env.DB_USER     || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME     || "attendance_db",
      waitForConnections: true,
      connectionLimit:    10,
      queueLimit:         0,
      dateStrings:        true, // prevent timezone mangling on DATE columns
    });
  }

  return pool;
}

/**
 * Run a parameterised query and return the rows array.
 * @param {string} sql
 * @param {any[]}  [values]
 * @returns {Promise<any[]>}
 */
async function query(sql, values = []) {
  const [rows] = await getPool().execute(sql, values);
  return rows;
}

/**
 * Auto-create all required tables if they don't exist.
 * Called once at server startup.
 */
async function initDb() {
  const conn = await getPool().getConnection();
  try {
    console.log("[DB] Initialising tables…");

    // ── Students master ────────────────────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS students (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        code          VARCHAR(50)  NOT NULL UNIQUE COMMENT 'EmployeeCode from SmartOffice',
        name          VARCHAR(255) NOT NULL,
        gender        VARCHAR(20)  DEFAULT '',
        contact       VARCHAR(20)  DEFAULT '',
        roll_no       VARCHAR(50)  DEFAULT '',
        standard      VARCHAR(50)  DEFAULT '',
        section       VARCHAR(50)  DEFAULT '',
        parent_name   VARCHAR(255) DEFAULT '',
        parent_mobile VARCHAR(20)  DEFAULT '',
        created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // ── Manual attendance overrides (punch edits / status changes) ─────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS attendance_overrides (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        student_code    VARCHAR(50)  NOT NULL,
        date            DATE         NOT NULL,
        status          VARCHAR(20)  DEFAULT NULL COMMENT 'Present|Absent|Late|On Leave',
        punch_in        VARCHAR(10)  DEFAULT NULL COMMENT 'HH:MM',
        punch_out       VARCHAR(10)  DEFAULT NULL COMMENT 'HH:MM',
        manually_edited TINYINT(1)   DEFAULT 1,
        updated_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_code_date (student_code, date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // ── Leave records ──────────────────────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS leaves (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        student_code VARCHAR(50) NOT NULL,
        date         DATE        NOT NULL,
        created_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_leave (student_code, date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log("[DB] ✅ Tables ready.");
  } finally {
    conn.release();
  }
}

module.exports = { getPool, query, initDb };
