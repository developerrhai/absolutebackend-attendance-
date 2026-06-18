/**
 * Students CRUD routes
 *
 * GET    /api/students           — list all students
 * POST   /api/students           — create a new student
 * GET    /api/students/:code     — get single student
 * PUT    /api/students/:code     — update student profile
 * DELETE /api/students/:code     — delete student + overrides + leaves
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
    const rows = await query(
      "SELECT * FROM students ORDER BY name ASC"
    );
    return res.json({ success: true, students: rows.map(mapStudent) });
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

    const [row] = await query("SELECT * FROM students WHERE code = ?", [code]);
    return res.status(201).json({ success: true, student: mapStudent(row) });
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
    return res.json({ success: true, student: mapStudent(rows[0]) });
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

    const [updated] = await query("SELECT * FROM students WHERE code = ?", [code]);
    return res.json({ success: true, student: mapStudent(updated) });
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

    // Remove attendance overrides and leaves first (FK-safe)
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
