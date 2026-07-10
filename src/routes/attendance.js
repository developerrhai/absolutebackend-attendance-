/**
 * Attendance routes
 *
 * GET  /api/attendance                        — fetch attendance for a date (join SmartOffice + DB)
 * POST /api/attendance/sync                   — force-refresh from SmartOffice
 * POST /api/attendance/leave                  — mark a student On Leave for a batch/day
 * PUT  /api/attendance/record                 — manually override punch/status for a batch
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

  // 3. Load student batches assignments
  const mappings = await query(
    `SELECT sb.student_code, sb.batch_id, b.name, b.start_time, b.end_time, b.late_grace_minutes 
     FROM student_batches sb
     JOIN batches b ON sb.batch_id = b.id`
  );
  
  const studentBatchesMap = new Map();
  for (const m of mappings) {
    const code = String(m.student_code).trim();
    if (!studentBatchesMap.has(code)) studentBatchesMap.set(code, []);
    studentBatchesMap.get(code).push({
      id: m.batch_id,
      name: m.name,
      start_time: m.start_time,
      end_time: m.end_time,
      late_grace_minutes: m.late_grace_minutes,
    });
  }

  // 4. Load leave set for this date
  const leaveRows = await query(
    "SELECT student_code, batch_id FROM leaves WHERE date = ?",
    [date]
  );
  // Store as student_code:batch_id strings. Whole-day leaves will have batch_id = null
  const leaveSet = new Set(
    leaveRows.map((r) => `${String(r.student_code).trim()}:${r.batch_id || "null"}`)
  );

  // 5. Load override map for this date
  const overrideRows = await query(
    "SELECT * FROM attendance_overrides WHERE date = ?",
    [date]
  );
  // Store mapped by student_code:batch_id
  const overrideMap = new Map(
    overrideRows.map((r) => [`${String(r.student_code).trim()}:${r.batch_id || "null"}`, r])
  );

  // 6. Build enriched records
  const records = buildAttendanceRecords(students, logs, date, leaveSet, overrideMap, studentBatchesMap);
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
  const { studentCode, date, batchId } = req.body;

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
      `INSERT INTO leaves (student_code, date, batch_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE created_at = created_at`,
      [studentCode, date, batchId || null]
    );

    return res.json({
      success: true,
      message: `Leave marked for student ${studentCode} on ${date} (Batch ID: ${batchId || 'all'})`,
    });
  } catch (err) {
    console.error("[Attendance] POST /leave", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/attendance/record ────────────────────────────────────────────────
router.put("/record", async (req, res) => {
  const { studentCode, date, status, punchIn, punchOut, batchId } = req.body;

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
      `INSERT INTO attendance_overrides (student_code, date, status, punch_in, punch_out, batch_id, manually_edited)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         status          = COALESCE(VALUES(status),    status),
         punch_in        = COALESCE(VALUES(punch_in),  punch_in),
         punch_out       = COALESCE(VALUES(punch_out), punch_out),
         manually_edited = 1`,
      [studentCode, date, status || null, punchIn || null, punchOut || null, batchId || null]
    );

    return res.json({
      success: true,
      message: `Attendance record updated for ${studentCode} on ${date} (Batch ID: ${batchId || 'all'})`,
    });
  } catch (err) {
    console.error("[Attendance] PUT /record", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/attendance/notify-whatsapp ──────────────────────────────────────
router.post("/notify-whatsapp", async (req, res) => {
  const axios = require("axios");
  const FormData = require("form-data");

  const { date } = req.body;

  if (!date) {
    return res.status(400).json({
      success: false,
      error: "date is required",
    });
  }

  try {
    const result = await getAttendanceForDate(date);

    const absentStudents = result.records.filter(
      (r) => r.status === "Absent"
    );

    const lateStudents = result.records.filter(
      (r) => r.status === "Late"
    );

    // Return immediate response to user and run sending in background
    res.json({
      success: true,
      message: `WhatsApp notification sending started in background for ${absentStudents.length} absent students.`,
      date,
      summary: {
        absent: absentStudents.length,
        late: lateStudents.length,
        whatsappSent: absentStudents.length,
        whatsappFailed: 0,
      },
      logs: [],
    });

    // Run the sending loop asynchronously in the background
    (async () => {
      let sent = 0;
      let failed = 0;

      for (const record of absentStudents) {
        try {
          const student = record.student;

          if (!student?.contact) {
            failed++;
            continue;
          }

          // Clean mobile number
          let mobile = String(student.contact).replace(/\D/g, "");
          if (!mobile.startsWith("91")) {
            mobile = "91" + mobile;
          }

          const form = new FormData();
          form.append(
            "appkey",
            process.env.WHATSAPP_APP_KEY || "63b954ad-a264-4f1a-bc06-738f3f8e0ea5"
          );
          form.append(
            "authkey",
            process.env.WHATSAPP_AUTH_KEY || "Ly1rcczQU9gILsKa4qW8vvTIAQ63BEmNH4g64HJyi7xsziQR4J"
          );
          form.append("to", mobile);
          form.append("template_id", process.env.WHATSAPP_TEMPLATE_ID || "attendence");
          form.append("language", "en");

          form.append("variables[{variableKey1}]", student.name);
          form.append("variables[{variableKey2}]", `Absent from ${record.batch.name}`);
          form.append(
            "variables[{variableKey3}]",
            new Date(date).toLocaleString("en-IN", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            })
          );

          await axios.post(
            "https://api.rhaitech.online/api/create-message",
            form,
            {
              headers: form.getHeaders(),
              timeout: 30000,
            }
          );

          sent++;
          console.log(`[WhatsApp Sent] ${student.name} - ${record.batch.name}`);
        } catch (err) {
          failed++;
          console.error(
            `[WhatsApp Failed] ${record.student?.name || "Unknown"} for batch ${record.batch?.name}:`,
            err.response?.data || err.message
          );
        }

        // 1500ms delay to avoid rate limit
        await new Promise((r) => setTimeout(r, 1500));
      }
      console.log(`[WhatsApp Batch Finished] Sent: ${sent}, Failed: ${failed}`);
    })().catch((err) => {
      console.error("[WhatsApp Background Loop Error]", err);
    });

  } catch (err) {
    console.error("[WhatsApp ERROR]", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;
