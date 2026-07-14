const express = require("express");
const { query } = require("../config/db");

const router = express.Router();

// ── GET /api/holidays ────────────────────────────────────────────────────────
// Fetches holidays. If ?month=YYYY-MM is provided, filters for that month.
router.get("/", async (req, res) => {
  const { month } = req.query;

  try {
    let sql = "SELECT * FROM holidays";
    let params = [];

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      sql += " WHERE date LIKE ?";
      params.push(`${month}%`);
    }

    sql += " ORDER BY date ASC";

    const rows = await query(sql, params);
    return res.json({ success: true, holidays: rows });
  } catch (err) {
    console.error("[Holidays] GET /", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/holidays ───────────────────────────────────────────────────────
// Create or update a holiday
router.post("/", async (req, res) => {
  const { date, reason = "", is_closed = 1 } = req.body;

  if (!date) {
    return res.status(400).json({
      success: false,
      error: "date is required (YYYY-MM-DD)",
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      success: false,
      error: "Invalid date format. Use YYYY-MM-DD",
    });
  }

  try {
    await query(
      `INSERT INTO holidays (date, reason, is_closed)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         reason    = VALUES(reason),
         is_closed = VALUES(is_closed)`,
      [date, reason, is_closed ? 1 : 0]
    );

    const [row] = await query("SELECT * FROM holidays WHERE date = ?", [date]);
    return res.status(200).json({ success: true, holiday: row });
  } catch (err) {
    console.error("[Holidays] POST /", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/holidays/:id ──────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const rows = await query("SELECT id FROM holidays WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Holiday not found" });
    }

    await query("DELETE FROM holidays WHERE id = ?", [id]);
    return res.json({ success: true, message: `Holiday ${id} deleted successfully.` });
  } catch (err) {
    console.error("[Holidays] DELETE /:id", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
