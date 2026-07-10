require("dotenv").config();

const SMARTOFFICE_BASE   = process.env.SMARTOFFICE_BASE_URL    || "http://13.232.199.167";
const API_KEY            = process.env.SMARTOFFICE_API_KEY     || "385619062612";
const DEFAULT_SERIAL     = process.env.SMARTOFFICE_SERIAL_NUMBER || "AMDB25121401560";

// Default virtual batch for students who don't have explicit batches assigned
const DEFAULT_BATCH = {
  id: null,
  name: "General Batch",
  start_time: "09:00:00",
  end_time: "17:30:00",
  late_grace_minutes: 15,
};

// ─── SmartOffice API ──────────────────────────────────────────────────────────

async function fetchBiometricLogs(fromDate, toDate, serial) {
  const serialNumber = serial || DEFAULT_SERIAL;

  const params = new URLSearchParams({
    APIKey:       API_KEY,
    FromDate:     fromDate,
    ToDate:       toDate,
    SerialNumber: serialNumber,
  });

  const url = `${SMARTOFFICE_BASE}/api/v2/WebAPI/GetDeviceLogs?${params}`;
  console.log(`[SmartOffice] GET ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`SmartOffice responded with HTTP ${res.status}`);
    }

    const data = await res.json();

    if (!Array.isArray(data)) {
      if (data?.status === false) {
        throw new Error(data.message || "SmartOffice API error");
      }
      throw new Error("Unexpected response format from SmartOffice");
    }

    console.log(`[SmartOffice] ✅ ${data.length} log(s) received`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Attendance computation ───────────────────────────────────────────────────

function parseLogDate(logDate) {
  return new Date(logDate.replace(" ", "T"));
}

function formatTime(date) {
  return date.toLocaleTimeString("en-IN", {
    hour:   "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(":");
  const h = Number(parts[0] || 0);
  const m = Number(parts[1] || 0);
  return h * 60 + m;
}

/**
 * Join students (from DB) with biometric logs (from SmartOffice) by EmployeeCode, per assigned batch.
 * Groups consecutive/adjacent batches into sessions if the gap is <= 3 hours (180 mins).
 */
function buildAttendanceRecords(students, logs, date, leaveSet, overrideMap, studentBatchesMap) {
  const byCode = new Map();
  for (const log of logs) {
    const code = String(log.EmployeeCode).trim();
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(log);
  }

  const records = [];

  for (const student of students) {
    const code = String(student.code).trim();
    const studentLogs = byCode.get(code) || [];

    // Get assigned batches or fall back to default
    const assignedBatches = studentBatchesMap.get(code) || [];
    const activeBatches = assignedBatches.length > 0 ? assignedBatches : [DEFAULT_BATCH];

    // Sort batches by start time
    const sortedBatches = [...activeBatches].sort((a, b) => {
      return timeToMinutes(a.start_time) - timeToMinutes(b.start_time);
    });

    // Group batches into contiguous sessions (time difference <= 180 minutes)
    const sessions = [];
    let currentSession = [];

    for (let i = 0; i < sortedBatches.length; i++) {
      const batch = sortedBatches[i];
      if (currentSession.length === 0) {
        currentSession.push(batch);
      } else {
        const lastBatch = currentSession[currentSession.length - 1];
        const lastEnd = timeToMinutes(lastBatch.end_time);
        const currentStart = timeToMinutes(batch.start_time);
        
        if (currentStart - lastEnd <= 180) {
          currentSession.push(batch);
        } else {
          sessions.push(currentSession);
          currentSession = [batch];
        }
      }
    }
    if (currentSession.length > 0) {
      sessions.push(currentSession);
    }

    // Process each session
    for (const session of sessions) {
      const firstBatch = session[0];
      const lastBatch = session[session.length - 1];

      const sSessionMin = timeToMinutes(firstBatch.start_time);
      const eSessionMin = timeToMinutes(lastBatch.end_time);

      // Filter logs for the entire session window [S_session - 30, E_session + 30]
      const sessionLogs = studentLogs
        .filter((log) => {
          const logTime = log.LogDate || log.DateTime;
          if (!logTime) return false;
          const logTimePart = logTime.split(" ")[1];
          const pMin = timeToMinutes(logTimePart);
          return pMin >= sSessionMin - 30 && pMin <= eSessionMin + 30;
        })
        .sort((a, b) => {
          const timeA = parseLogDate(a.LogDate || a.DateTime).getTime();
          const timeB = parseLogDate(b.LogDate || b.DateTime).getTime();
          return timeA - timeB;
        });

      const sessionPunchIn = sessionLogs.length > 0 ? sessionLogs[0] : null;
      const sessionPunchOut = sessionLogs.length > 1 ? sessionLogs[sessionLogs.length - 1] : null;

      for (const batch of session) {
        const batchId = batch.id;
        const sMin = timeToMinutes(batch.start_time);
        const eMin = timeToMinutes(batch.end_time);
        const grace = batch.late_grace_minutes ?? 10;

        let status = "Absent";
        let punchIn = null;
        let punchOut = null;
        let serialNumber = "—";
        let temperature = null;
        let temperatureState = null;

        if (sessionPunchIn) {
          const pInTime = (sessionPunchIn.LogDate || sessionPunchIn.DateTime).split(" ")[1];
          const pInMin = timeToMinutes(pInTime);

          if (pInMin <= eMin) {
            // Student entered before this batch ended
            status = pInMin <= sMin + grace ? "Present" : "Late";
            punchIn = formatTime(parseLogDate(sessionPunchIn.LogDate || sessionPunchIn.DateTime));
            serialNumber = sessionPunchIn.SerialNumber || "—";
            temperature = sessionPunchIn.Temperature || null;
            temperatureState = sessionPunchIn.TemperatureState || null;
          }
        }

        if (sessionPunchOut) {
          const pOutTime = (sessionPunchOut.LogDate || sessionPunchOut.DateTime).split(" ")[1];
          const pOutMin = timeToMinutes(pOutTime);

          // Punch out must be after the start time of the batch to count as a checkout for it
          if (pOutMin > sMin) {
            punchOut = formatTime(parseLogDate(sessionPunchOut.LogDate || sessionPunchOut.DateTime));
          }
        }

        // Apply leave
        const isOnLeave = leaveSet && (leaveSet.has(`${code}:${batchId}`) || leaveSet.has(`${code}:null`));
        if (isOnLeave) {
          status   = "On Leave";
          punchIn  = null;
          punchOut = null;
        }

        // Apply manual override
        const overrideKey = `${code}:${batchId}`;
        const fallbackKey = `${code}:null`;
        const override = overrideMap && (overrideMap.get(overrideKey) || overrideMap.get(fallbackKey));
        
        if (override) {
          if (override.status)    status   = override.status;
          if (override.punch_in)  punchIn  = override.punch_in;
          if (override.punch_out) punchOut = override.punch_out;
        }

        records.push({
          student: {
            id:           student.id,
            code:         student.code,
            name:         student.name,
            gender:       student.gender        || "",
            contact:      student.contact       || "",
            rollNo:       student.roll_no       || "",
            standard:     student.standard      || "",
            section:      student.section       || "",
            parentName:   student.parent_name   || "",
            parentMobile: student.parent_mobile || "",
          },
          batch: {
            id:        batch.id,
            name:      batch.name,
            startTime: batch.start_time,
            endTime:   batch.end_time,
          },
          date,
          punchIn,
          punchOut,
          serialNumber,
          status,
          temperature,
          temperatureState,
          logCount: sessionLogs.length,
          manuallyEdited: !!override,
        });
      }
    }
  }

  return records;
}

function computeSummary(records) {
  return {
    total:   records.length,
    present: records.filter((r) => r.status === "Present").length,
    absent:  records.filter((r) => r.status === "Absent").length,
    late:    records.filter((r) => r.status === "Late").length,
    onLeave: records.filter((r) => r.status === "On Leave").length,
  };
}

module.exports = {
  fetchBiometricLogs,
  buildAttendanceRecords,
  computeSummary,
  timeToMinutes,
};
