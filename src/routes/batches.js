const express = require("express");
const { query } = require("../config/db");

const router = express.Router();

// ── GET /api/batches ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const rows = await query("SELECT * FROM batches ORDER BY name ASC");
    return res.json({ success: true, batches: rows });
  } catch (err) {
    console.error("[Batches] GET /", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/batches ────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const { name, start_time, end_time, late_grace_minutes = 10 } = req.body;

  if (!name || !start_time || !end_time) {
    return res.status(400).json({
      success: false,
      error: "name, start_time, and end_time are required",
    });
  }

  try {
    const result = await query(
      `INSERT INTO batches (name, start_time, end_time, late_grace_minutes)
       VALUES (?, ?, ?, ?)`,
      [name, start_time, end_time, late_grace_minutes]
    );

    const newId = result.insertId;
    const [row] = await query("SELECT * FROM batches WHERE id = ?", [newId]);
    return res.status(201).json({ success: true, batch: row });
  } catch (err) {
    console.error("[Batches] POST /", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/batches/:id ──────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, start_time, end_time, late_grace_minutes } = req.body;

  try {
    const rows = await query("SELECT id FROM batches WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Batch not found" });
    }

    await query(
      `UPDATE batches SET
         name               = COALESCE(?, name),
         start_time         = COALESCE(?, start_time),
         end_time           = COALESCE(?, end_time),
         late_grace_minutes = COALESCE(?, late_grace_minutes)
       WHERE id = ?`,
      [name ?? null, start_time ?? null, end_time ?? null, late_grace_minutes ?? null, id]
    );

    const [updated] = await query("SELECT * FROM batches WHERE id = ?", [id]);
    return res.json({ success: true, batch: updated });
  } catch (err) {
    console.error("[Batches] PUT /:id", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/batches/:id ───────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const rows = await query("SELECT id FROM batches WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Batch not found" });
    }

    // Delete cascading mappings
    await query("DELETE FROM student_batches WHERE batch_id = ?", [id]);
    // Set overrides/leaves referencing this batch to NULL or delete them
    await query("DELETE FROM attendance_overrides WHERE batch_id = ?", [id]);
    await query("DELETE FROM leaves WHERE batch_id = ?", [id]);
    
    await query("DELETE FROM batches WHERE id = ?", [id]);

    return res.json({ success: true, message: `Batch ${id} deleted successfully.` });
  } catch (err) {
    console.error("[Batches] DELETE /:id", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/batches/student/:code ────────────────────────────────────────────
// Get all batches mapped to a specific student
router.get("/student/:code", async (req, res) => {
  const { code } = req.params;

  try {
    const rows = await query(
      `SELECT b.* 
       FROM batches b
       JOIN student_batches sb ON b.id = sb.batch_id
       WHERE sb.student_code = ?`,
      [code]
    );
    return res.json({ success: true, batches: rows });
  } catch (err) {
    console.error("[Batches] GET /student/:code", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/batches/student/:code ───────────────────────────────────────────
// Assign multiple batches to a student
router.post("/student/:code", async (req, res) => {
  const { code } = req.params;
  const { batchIds } = req.body; // Array of batch IDs e.g. [1, 2]

  if (!Array.isArray(batchIds)) {
    return res.status(400).json({ success: false, error: "batchIds must be an array" });
  }

  try {
    // Verify student exists
    const students = await query("SELECT id FROM students WHERE code = ?", [code]);
    if (!students.length) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }

    // Clear existing mappings
    await query("DELETE FROM student_batches WHERE student_code = ?", [code]);

    // Insert new mappings
    if (batchIds.length > 0) {
      const values = batchIds.map((batchId) => [code, batchId]);
      await query(
        "INSERT INTO student_batches (student_code, batch_id) VALUES ?",
        [values]
      );
    }

    return res.json({ success: true, message: `Student batches updated successfully.` });
  } catch (err) {
    console.error("[Batches] POST /student/:code", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
