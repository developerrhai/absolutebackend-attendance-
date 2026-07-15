const express = require("express");
const ExcelJS = require("exceljs");
const { query } = require("../config/db");
const { fetchBiometricLogs, buildAttendanceRecords } = require("../services/smartoffice");

const router = express.Router();

/**
 * Helper to get all dates between startDate and endDate
 */
function getDatesInRange(startDate, endDate) {
  const dates = [];
  let currentDate = new Date(startDate);
  const end = new Date(endDate);
  
  while (currentDate <= end) {
    dates.push(currentDate.toISOString().split('T')[0]);
    currentDate.setDate(currentDate.getDate() + 1);
  }
  return dates;
}

// ── POST /api/reports/generate ─────────────────────────────────────────────
function escapeCSV(field) {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

router.post("/generate", async (req, res) => {
  const { type, batchId, startDate, endDate } = req.body;

  if (!type) {
    return res.status(400).json({ error: "Report type is required" });
  }
  if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
    return res.status(400).json({ error: "Start date cannot be after end date" });
  }

  try {
    if (type === "attendance") {
      if (!startDate || !endDate) {
        return res.status(400).json({ error: "startDate and endDate are required for attendance report" });
      }

      // 1. Fetch Students
      const students = await query("SELECT * FROM students ORDER BY name ASC");

      // 2. Fetch Batches
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

      // 3. Fetch Overrides & Leaves for the whole date range
      const leaveRows = await query(
        "SELECT student_code, date, batch_id FROM leaves WHERE date BETWEEN ? AND ?",
        [startDate, endDate]
      );
      const overrideRows = await query(
        "SELECT * FROM attendance_overrides WHERE date BETWEEN ? AND ?",
        [startDate, endDate]
      );

      // 4. Fetch Biometric Logs for the whole date range
      let logs = [];
      try {
        logs = await fetchBiometricLogs(startDate, endDate);
      } catch (err) {
        console.warn(`[Reports] SmartOffice error: ${err.message}`);
      }

      // 5. Initialize CSV Stream
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="attendance_report.csv"`);
      
      // Write Header
      res.write("Date,Student Name,Code,Standard/Class,Batch,Status,Punch In,Punch Out\n");

      // 6. Process day by day
      const dates = getDatesInRange(startDate, endDate);
      
      for (const date of dates) {
        // Filter overrides and leaves for this specific date
        const leaveSet = new Set(
          leaveRows
            .filter((r) => r.date === date || new Date(r.date).toISOString().split('T')[0] === date)
            .map((r) => `${String(r.student_code).trim()}:${r.batch_id || "null"}`)
        );

        const overrideMap = new Map(
          overrideRows
            .filter((r) => r.date === date || new Date(r.date).toISOString().split('T')[0] === date)
            .map((r) => [`${String(r.student_code).trim()}:${r.batch_id || "null"}`, r])
        );

        // Filter logs for this specific date
        const dateLogs = logs.filter((l) => {
          const logTime = l.LogDate || l.DateTime;
          if (!logTime) return false;
          const logD = new Date(logTime.replace(" ", "T")).toISOString().split('T')[0];
          return logD === date;
        });

        const records = buildAttendanceRecords(
          students,
          dateLogs,
          date,
          leaveSet,
          overrideMap,
          studentBatchesMap
        );

        // Stream rows to CSV
        for (const record of records) {
          // If a batch filter is applied, skip records not matching the batch
          if (batchId && batchId !== "all" && String(record.batch.id) !== String(batchId)) {
            continue;
          }

          const row = [
            record.date,
            record.student.name,
            record.student.code,
            record.student.standard || "-",
            record.batch.name,
            record.status,
            record.punchIn || "-",
            record.punchOut || "-"
          ].map(escapeCSV).join(",");
          
          res.write(row + "\n");
        }
      }

      res.end();
      return; // End response
    } 
    
    if (type === "students") {
      // Setup Student Report CSV Stream
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="students_report.csv"`);
      
      // Write Header
      res.write("Code,Name,Gender,Contact,Standard,Batches\n");

      const students = await query("SELECT * FROM students ORDER BY name ASC");
      const mappings = await query(
        `SELECT sb.student_code, b.name 
         FROM student_batches sb
         JOIN batches b ON sb.batch_id = b.id`
      );

      const studentBatchesMap = new Map();
      for (const m of mappings) {
        const code = String(m.student_code).trim();
        if (!studentBatchesMap.has(code)) studentBatchesMap.set(code, []);
        studentBatchesMap.get(code).push(m);
      }

      for (const student of students) {
        const studentBatches = studentBatchesMap.get(String(student.code).trim()) || [];
        
        const row = [
          student.code,
          student.name,
          student.gender,
          student.contact,
          student.standard || "-",
          studentBatches.map(b => b.name).join(", ") || "General Batch"
        ].map(escapeCSV).join(",");
        
        res.write(row + "\n");
      }

      res.end();
      return;
    }

    return res.status(400).json({ error: "Invalid report type" });
  } catch (error) {
    console.error("[Reports] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate report" });
    } else {
      res.end(); // close stream
    }
  }
});

module.exports = router;
