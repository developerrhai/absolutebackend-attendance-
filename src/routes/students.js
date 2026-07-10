/**
 * Students CRUD routes
 *
 * GET    /api/students           — list all students (including their mapped batches)
 * POST   /api/students           — create/upsert student (and save their batch mappings)
 * GET    /api/students/:code     — get single student
 * PUT    /api/students/:code     — update student profile (and update batch mappings)
 * DELETE /api/students/:code     — delete student + overrides + leaves + batch mappings
 */

const express = require("express");
const { query } = require("../config/db");

const router = express.Router();

// ─── Helper: map DB row → frontend shape ──────────────────────────────────────
function mapStudent(row) {
  return {
    id:           row.id,
    code:         row.code,
    name:         row.name,
    gender:       row.gender        || "",
    contact:      row.contact       || "",
    rollNo:       row.roll_no       || "",
    standard:     row.standard      || "",
    section:      row.section       || "",
    parentName:   row.parent_name   || "",
    parentMobile: row.parent_mobile || "",
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

// ── GET /api/students ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const students = await query(
      "SELECT * FROM students ORDER BY name ASC"
    );
    const mappings = await query(
      `SELECT sb.student_code, sb.batch_id, b.name, b.start_time, b.end_time 
       FROM student_batches sb 
       JOIN batches b ON sb.batch_id = b.id`
    );

    const batchMap = new Map();
    for (const m of mappings) {
      const code = String(m.student_code).trim();
      if (!batchMap.has(code)) batchMap.set(code, []);
      batchMap.get(code).push({
        id: m.batch_id,
        name: m.name,
        startTime: m.start_time,
        endTime: m.end_time
      });
    }

    const studentsWithBatches = students.map((s) => {
      const mapped = mapStudent(s);
      mapped.batches = batchMap.get(String(s.code).trim()) || [];
      return mapped;
    });

    return res.json({ success: true, students: studentsWithBatches });
  } catch (err) {
    console.error("[Students] GET /", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/students ────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const {
    code, name, gender = "", contact = "",
    rollNo = "", standard = "", section = "",
    parentName = "", parentMobile = "",
    batchIds = []
  } = req.body;

  if (!code || !name) {
    return res.status(400).json({
      success: false,
      error: "code and name are required",
    });
  }

  try {
    await query(
      `INSERT INTO students
         (code, name, gender, contact, roll_no, standard, section, parent_name, parent_mobile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name          = VALUES(name),
         gender        = VALUES(gender),
         contact       = VALUES(contact),
         roll_no       = VALUES(roll_no),
         standard      = VALUES(standard),
         section       = VALUES(section),
         parent_name   = VALUES(parent_name),
         parent_mobile = VALUES(parent_mobile)`,
      [code, name, gender, contact, rollNo, standard, section, parentName, parentMobile]
    );

    // Update batch mappings
    await query("DELETE FROM student_batches WHERE student_code = ?", [code]);
    if (Array.isArray(batchIds) && batchIds.length > 0) {
      const values = batchIds.map((batchId) => [code, batchId]);
      await query(
        "INSERT INTO student_batches (student_code, batch_id) VALUES ?",
        [values]
      );
    }

    const [row] = await query("SELECT * FROM students WHERE code = ?", [code]);
    const mapped = mapStudent(row);

    // Fetch updated mapped batches
    const studentBatches = await query(
      `SELECT b.* FROM batches b JOIN student_batches sb ON b.id = sb.batch_id WHERE sb.student_code = ?`,
      [code]
    );
    mapped.batches = studentBatches.map(b => ({
      id: b.id,
      name: b.name,
      startTime: b.start_time,
      endTime: b.end_time
    }));

    return res.status(201).json({ success: true, student: mapped });
  } catch (err) {
    console.error("[Students] POST /", err.message);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        error: `A student with code "${code}" already exists.`,
      });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/students/:code ───────────────────────────────────────────────────
router.get("/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const rows = await query("SELECT * FROM students WHERE code = ?", [code]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }
    const mapped = mapStudent(rows[0]);

    // Fetch mapped batches
    const studentBatches = await query(
      `SELECT b.* FROM batches b JOIN student_batches sb ON b.id = sb.batch_id WHERE sb.student_code = ?`,
      [code]
    );
    mapped.batches = studentBatches.map(b => ({
      id: b.id,
      name: b.name,
      startTime: b.start_time,
      endTime: b.end_time
    }));

    return res.json({ success: true, student: mapped });
  } catch (err) {
    console.error("[Students] GET /:code", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/students/:code ───────────────────────────────────────────────────
router.put("/:code", async (req, res) => {
  const { code } = req.params;
  const {
    name, gender, contact,
    rollNo, standard, section,
    parentName, parentMobile,
    batchIds
  } = req.body;

  try {
    const rows = await query("SELECT id FROM students WHERE code = ?", [code]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }

    await query(
      `UPDATE students SET
         name          = COALESCE(?, name),
         gender        = COALESCE(?, gender),
         contact       = COALESCE(?, contact),
         roll_no       = COALESCE(?, roll_no),
         standard      = COALESCE(?, standard),
         section       = COALESCE(?, section),
         parent_name   = COALESCE(?, parent_name),
         parent_mobile = COALESCE(?, parent_mobile)
       WHERE code = ?`,
      [
        name         ?? null,
        gender       ?? null,
        contact      ?? null,
        rollNo       ?? null,
        standard     ?? null,
        section      ?? null,
        parentName   ?? null,
        parentMobile ?? null,
        code,
      ]
    );

    // Save batch mappings if provided
    if (batchIds !== undefined && Array.isArray(batchIds)) {
      await query("DELETE FROM student_batches WHERE student_code = ?", [code]);
      if (batchIds.length > 0) {
        const values = batchIds.map((batchId) => [code, batchId]);
        await query(
          "INSERT INTO student_batches (student_code, batch_id) VALUES ?",
          [values]
        );
      }
    }

    const [updated] = await query("SELECT * FROM students WHERE code = ?", [code]);
    const mapped = mapStudent(updated);

    // Fetch updated mapped batches
    const studentBatches = await query(
      `SELECT b.* FROM batches b JOIN student_batches sb ON b.id = sb.batch_id WHERE sb.student_code = ?`,
      [code]
    );
    mapped.batches = studentBatches.map(b => ({
      id: b.id,
      name: b.name,
      startTime: b.start_time,
      endTime: b.end_time
    }));

    return res.json({ success: true, student: mapped });
  } catch (err) {
    console.error("[Students] PUT /:code", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/students/:code ────────────────────────────────────────────────
router.delete("/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const rows = await query("SELECT id FROM students WHERE code = ?", [code]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }

    // Remove attendance overrides, leaves, batch mappings, and student
    await query("DELETE FROM student_batches WHERE student_code = ?", [code]);
    await query("DELETE FROM attendance_overrides WHERE student_code = ?", [code]);
    await query("DELETE FROM leaves WHERE student_code = ?", [code]);
    await query("DELETE FROM students WHERE code = ?", [code]);

    return res.json({ success: true, message: `Student ${code} deleted.` });
  } catch (err) {
    console.error("[Students] DELETE /:code", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
