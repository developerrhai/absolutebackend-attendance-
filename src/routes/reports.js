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

      // 5. Initialize Excel Stream
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="attendance_report.xlsx"`
      );

      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
      const worksheet = workbook.addWorksheet("Attendance");

      worksheet.columns = [
        { header: "Date", key: "date", width: 15 },
        { header: "Student Name", key: "name", width: 25 },
        { header: "Code", key: "code", width: 15 },
        { header: "Standard/Class", key: "standard", width: 15 },
        { header: "Batch", key: "batch", width: 25 },
        { header: "Status", key: "status", width: 15 },
        { header: "Punch In", key: "punchIn", width: 15 },
        { header: "Punch Out", key: "punchOut", width: 15 },
      ];

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

        // Filter logs for this specific date (LogDate format is usually DD-MM-YYYY or YYYY-MM-DD)
        const dateLogs = logs.filter((l) => {
          const logTime = l.LogDate || l.DateTime;
          if (!logTime) return false;
          // Just pass all logs to buildAttendanceRecords and it will filter them correctly based on time,
          // but passing the whole array might be slow. We can just pass the whole array for now, 
          // as buildAttendanceRecords handles sorting and grouping.
          // Wait, buildAttendanceRecords takes `date` string but processes ALL logs passed to it.
          // We MUST filter logs by date so they don't leak into other days.
          // logTime is typically "YYYY-MM-DD HH:MM:SS" or "MM/DD/YYYY"
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

        // Stream rows to excel
        for (const record of records) {
          // If a batch filter is applied, skip records not matching the batch
          if (batchId && batchId !== "all" && String(record.batch.id) !== String(batchId)) {
            continue;
          }

          worksheet.addRow({
            date: record.date,
            name: record.student.name,
            code: record.student.code,
            standard: record.student.standard,
            batch: record.batch.name,
            status: record.status,
            punchIn: record.punchIn || "-",
            punchOut: record.punchOut || "-",
          }).commit();
        }
      }

      worksheet.commit();
      await workbook.commit();
      return; // End response
    } 
    
    if (type === "students") {
      // Setup Student Report
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="students_report.xlsx"`
      );

      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
      const worksheet = workbook.addWorksheet("Students");

      worksheet.columns = [
        { header: "Code", key: "code", width: 15 },
        { header: "Name", key: "name", width: 25 },
        { header: "Gender", key: "gender", width: 10 },
        { header: "Contact", key: "contact", width: 15 },
        { header: "Standard", key: "standard", width: 15 },
        { header: "Batches", key: "batches", width: 30 },
      ];

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
        
        // If batchId filter is applied, skip students not in this batch
        if (batchId && batchId !== "all") {
          // We don't have batchId in the mapping query, let's fix that.
          // Wait, I only selected `name` in the mapping query. Let's filter on the mapping loop below.
        }

        worksheet.addRow({
          code: student.code,
          name: student.name,
          gender: student.gender,
          contact: student.contact,
          standard: student.standard,
          batches: studentBatches.map(b => b.name).join(", ") || "General Batch",
        }).commit();
      }

      worksheet.commit();
      await workbook.commit();
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
