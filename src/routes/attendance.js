/**
 * Attendance routes
 *
 * GET  /api/attendance                        — fetch attendance for a date (join SmartOffice + DB)
 * POST /api/attendance/sync                   — force-refresh from SmartOffice
 * POST /api/attendance/leave                  — mark a student On Leave
 * PUT  /api/attendance/record                 — manually override punch/status
 * POST /api/attendance/notify-whatsapp        — send WhatsApp alerts for absent students
 */

const express = require("express");
const { query } = require("../config/db");
const {
  fetchBiometricLogs,
  buildAttendanceRecords,
  computeSummary,
} = require("../services/smartoffice");

const router = express.Router();

// ─── Shared: build full attendance response for a date ────────────────────────
async function getAttendanceForDate(date) {
  // 1. Load all students from DB
  const students = await query(
    "SELECT * FROM students ORDER BY name ASC"
  );

  // 2. Fetch raw biometric logs from SmartOffice
  let logs = [];
  let smartOfficeError = null;
  try {
    logs = await fetchBiometricLogs(date, date);
  } catch (err) {
    smartOfficeError = err.message;
    console.warn(`[Attendance] SmartOffice error (proceeding with DB data): ${err.message}`);
  }

  // 3. Load leave set for this date
  const leaveRows = await query(
    "SELECT student_code FROM leaves WHERE date = ?",
    [date]
  );
  const leaveSet = new Set(leaveRows.map((r) => String(r.student_code).trim()));

  // 4. Load override map for this date
  const overrideRows = await query(
    "SELECT * FROM attendance_overrides WHERE date = ?",
    [date]
  );
  const overrideMap = new Map(
    overrideRows.map((r) => [String(r.student_code).trim(), r])
  );

  // 5. Build enriched records
  const records = buildAttendanceRecords(students, logs, date, leaveSet, overrideMap);
  const summary = computeSummary(records);

  return {
    success:          true,
    records,
    summary,
    syncedAt:         new Date().toISOString(),
    smartOfficeError: smartOfficeError || undefined,
  };
}

// ── GET /api/attendance?date=YYYY-MM-DD ───────────────────────────────────────
router.get("/", async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({
      success: false,
      error: "date query param is required (YYYY-MM-DD)",
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      success: false,
      error: "Invalid date format. Use YYYY-MM-DD",
    });
  }

  try {
    const result = await getAttendanceForDate(date);
    return res.json(result);
  } catch (err) {
    console.error("[Attendance] GET /", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/attendance/sync ─────────────────────────────────────────────────
router.post("/sync", async (req, res) => {
  const { date } = req.body;

  if (!date) {
    return res.status(400).json({
      success: false,
      error: "date is required in the request body",
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      success: false,
      error: "Invalid date format. Use YYYY-MM-DD",
    });
  }

  try {
    const result = await getAttendanceForDate(date);
    return res.json(result);
  } catch (err) {
    console.error("[Attendance] POST /sync", err.message);
    return res.status(502).json({ success: false, error: err.message });
  }
});

// ── POST /api/attendance/leave ────────────────────────────────────────────────
router.post("/leave", async (req, res) => {
  const { studentCode, date } = req.body;

  if (!studentCode || !date) {
    return res.status(400).json({
      success: false,
      error: "studentCode and date are required",
    });
  }

  try {
    // Ensure student exists
    const students = await query(
      "SELECT id FROM students WHERE code = ?",
      [studentCode]
    );
    if (!students.length) {
      return res.status(404).json({
        success: false,
        error: `Student with code "${studentCode}" not found`,
      });
    }

    // Upsert leave record
    await query(
      `INSERT INTO leaves (student_code, date)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE created_at = created_at`,
      [studentCode, date]
    );

    return res.json({
      success: true,
      message: `Leave marked for student ${studentCode} on ${date}`,
    });
  } catch (err) {
    console.error("[Attendance] POST /leave", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/attendance/record ────────────────────────────────────────────────
router.put("/record", async (req, res) => {
  const { studentCode, date, status, punchIn, punchOut } = req.body;

  if (!studentCode || !date) {
    return res.status(400).json({
      success: false,
      error: "studentCode and date are required",
    });
  }

  const validStatuses = ["Present", "Absent", "Late", "On Leave"];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      error: `status must be one of: ${validStatuses.join(", ")}`,
    });
  }

  try {
    // Upsert override
    await query(
      `INSERT INTO attendance_overrides (student_code, date, status, punch_in, punch_out, manually_edited)
       VALUES (?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         status          = COALESCE(VALUES(status),    status),
         punch_in        = COALESCE(VALUES(punch_in),  punch_in),
         punch_out       = COALESCE(VALUES(punch_out), punch_out),
         manually_edited = 1`,
      [studentCode, date, status || null, punchIn || null, punchOut || null]
    );

    return res.json({
      success: true,
      message: `Attendance record updated for ${studentCode} on ${date}`,
    });
  } catch (err) {
    console.error("[Attendance] PUT /record", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/attendance/notify-whatsapp ──────────────────────────────────────
router.post("/notify-whatsapp", async (req, res) => {
  const { date } = req.body;

  if (!date) {
    return res.status(400).json({ success: false, error: "date is required" });
  }

  try {
    const result = await getAttendanceForDate(date);

    const absentStudents = result.records.filter(
      (r) => r.status === "Absent"
    );
    const lateStudents = result.records.filter(
      (r) => r.status === "Late"
    );

    // ─────────────────────────────────────────────────────────────────────────
    // TODO: Wire up to Twilio WhatsApp / WhatsApp Business API here.
    //
    // Example (Twilio):
    //   const twilio = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    //   for (const r of absentStudents) {
    //     await twilio.messages.create({
    //       from: "whatsapp:+14155238886",
    //       to:   `whatsapp:+91${r.student.contact}`,
    //       body: `Dear ${r.student.parentName || "Parent"}, your ward ${r.student.name} was ABSENT on ${date}.`,
    //     });
    //   }
    // ─────────────────────────────────────────────────────────────────────────

    console.log(`[WhatsApp] Date: ${date}`);
    console.log(`  Absent (${absentStudents.length}):`, absentStudents.map((r) => r.student.name).join(", "));
    console.log(`  Late   (${lateStudents.length}):`,  lateStudents.map((r) => r.student.name).join(", "));

    return res.json({
      success: true,
      message: `Notification summary for ${date}: ${absentStudents.length} absent, ${lateStudents.length} late. (WhatsApp integration is a placeholder — wire to Twilio or WhatsApp Business API.)`,
      absent:  absentStudents.map((r) => ({ name: r.student.name, contact: r.student.contact, parentMobile: r.student.parentMobile })),
      late:    lateStudents.map((r)   => ({ name: r.student.name, contact: r.student.contact, parentMobile: r.student.parentMobile })),
    });
  } catch (err) {
    console.error("[WhatsApp] POST /notify-whatsapp", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
