const axios = require("axios");
const sendWhatsApp = require("./sendWhatsApp");
const { query } = require("../config/db");
const { timeToMinutes } = require("../services/smartoffice");

const SMARTOFFICE_BASE   = process.env.SMARTOFFICE_BASE_URL      || "http://13.232.199.167";
const API_KEY            = process.env.SMARTOFFICE_API_KEY       || "385619062612";
const DEFAULT_SERIAL     = process.env.SMARTOFFICE_SERIAL_NUMBER || "AMDB25121401560";

let lastLogTime = null; // store last processed punch
let isFirstRun = true;  // skip sending notifications on startup for historical logs today

function todayDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const dd   = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function checkNewPunches() {
  try {
    const today = todayDate();

    const url =
      `${SMARTOFFICE_BASE}/api/v2/WebAPI/GetDeviceLogs` +
      `?APIKey=${API_KEY}` +
      `&FromDate=${today}` +
      `&ToDate=${today}` +
      `&SerialNumber=${DEFAULT_SERIAL}`;

    const res = await axios.get(url, { timeout: 15000 });

    const rawLogs = Array.isArray(res.data) ? res.data : (res.data?.data || []);

    const logs = rawLogs.filter((log) => log.LogDate || log.DateTime).sort((a, b) => {
      const dateA = new Date((a.LogDate || a.DateTime).replace(" ", "T"));
      const dateB = new Date((b.LogDate || b.DateTime).replace(" ", "T"));
      return dateA - dateB;
    });

    if (isFirstRun) {
      isFirstRun = false;
      if (logs.length > 0) {
        lastLogTime = logs[logs.length - 1].LogDate || logs[logs.length - 1].DateTime;
        console.log(`[Watcher] Initialized lastLogTime on startup to: ${lastLogTime}`);
      } else {
        console.log("[Watcher] No logs found today yet. Initialized lastLogTime to null");
      }
      return;
    }

    for (const log of logs) {
      const logTime = log.LogDate || log.DateTime;

      // skip old logs
      if (lastLogTime && new Date(logTime) <= new Date(lastLogTime)) {
        continue;
      }

      lastLogTime = logTime;

      try {
        const studentCode = String(log.EmployeeCode).trim();
        const students = await query(
          "SELECT name, parent_mobile, contact FROM students WHERE TRIM(code) = ?",
          [studentCode]
        );

        if (students && students.length > 0) {
          const student = students[0];
          log.EmployeeName = student.name;
          log.Mobile = student.parent_mobile || student.contact;

          // Determine punch direction (In/Out) dynamically based on punch count today
          const studentPunches = logs
            .filter((l) => String(l.EmployeeCode).trim() === studentCode)
            .sort((a, b) => {
              const dateA = new Date((a.LogDate || a.DateTime).replace(" ", "T"));
              const dateB = new Date((b.LogDate || b.DateTime).replace(" ", "T"));
              return dateA - dateB;
            });

          const punchIndex = studentPunches.findIndex(
            (l) => (l.LogDate || l.DateTime) === (log.LogDate || log.DateTime)
          );

          // Even index (0, 2, 4...) -> Entry (0), Odd index (1, 3, 5...) -> Exit (1)
          log.InOutMode = (punchIndex !== -1 && punchIndex % 2 === 0) ? 0 : 1;

          // Look up mapped batches for student
          const assignedBatches = await query(
            `SELECT b.* FROM batches b JOIN student_batches sb ON b.id = sb.batch_id WHERE sb.student_code = ?`,
            [studentCode]
          );

          const logTimeOnly = logTime.split(" ")[1];
          const pMin = timeToMinutes(logTimeOnly);

          let matchedBatch = null;
          for (const b of assignedBatches) {
            const sMin = timeToMinutes(b.start_time);
            const eMin = timeToMinutes(b.end_time);
            if (pMin >= sMin - 30 && pMin <= eMin + 30) {
              matchedBatch = b;
              break;
            }
          }

          if (log.InOutMode === 0) {
            if (matchedBatch) {
              const sMin = timeToMinutes(matchedBatch.start_time);
              const grace = matchedBatch.late_grace_minutes ?? 10;
              const isLate = pMin > sMin + grace;
              log.CustomStatus = isLate 
                ? `Late in ${matchedBatch.name}` 
                : `Present in ${matchedBatch.name}`;
            } else {
              log.CustomStatus = "Present (General)";
            }
          } else {
            if (matchedBatch) {
              log.CustomStatus = `Exited from ${matchedBatch.name}`;
            } else {
              log.CustomStatus = "Exited";
            }
          }

          await sendWhatsApp(log);
        } else {
          console.log(`[Watcher] Student not found in database for code: ${studentCode}`);
        }
      } catch (dbErr) {
        console.error(`[Watcher] DB Lookup Error for code ${log.EmployeeCode}:`, dbErr.message);
      }

      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    console.log("[Watcher] Error:", err.message);
  }
}

// Run every 30 seconds
setInterval(checkNewPunches, 30000);

// Run once on startup after a short delay
setTimeout(checkNewPunches, 5000);

console.log("[Watcher] ✅ Attendance watcher started (polling every 30s)");

module.exports = { checkNewPunches };
