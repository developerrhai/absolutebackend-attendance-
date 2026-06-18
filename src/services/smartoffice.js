require("dotenv").config();

const SMARTOFFICE_BASE   = process.env.SMARTOFFICE_BASE_URL    || "http://13.232.199.167";
const API_KEY            = process.env.SMARTOFFICE_API_KEY     || "385619062612";
const DEFAULT_SERIAL     = process.env.SMARTOFFICE_SERIAL_NUMBER || "AMDB25121401560";

// Late threshold: punch-in after 09:15 = "Late"
const LATE_HOUR   = 9;
const LATE_MINUTE = 15;

// ─── SmartOffice API ──────────────────────────────────────────────────────────

/**
 * Fetch raw biometric logs from SmartOffice GetDeviceLogs API.
 * @param {string} fromDate   YYYY-MM-DD
 * @param {string} toDate     YYYY-MM-DD
 * @param {string} [serial]   Device serial number
 * @returns {Promise<Array>}  Array of BiometricLog objects
 */
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

  // AbortSignal.timeout is available in Node ≥ 17.3; safe fallback for older
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
  // SmartOffice format: "2026-05-21 08:45:29"
  return new Date(logDate.replace(" ", "T"));
}

function formatTime(date) {
  return date.toLocaleTimeString("en-IN", {
    hour:   "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function computeStatus(logs) {
  if (!logs.length) return { status: "Absent", punchIn: null, punchOut: null };

  const sorted = [...logs].sort(
    (a, b) => parseLogDate(a.LogDate).getTime() - parseLogDate(b.LogDate).getTime()
  );

  const first = parseLogDate(sorted[0].LogDate);
  const last  = sorted.length > 1 ? parseLogDate(sorted[sorted.length - 1].LogDate) : null;

  const threshold = new Date(first);
  threshold.setHours(LATE_HOUR, LATE_MINUTE, 0, 0);

  return {
    status:   first > threshold ? "Late" : "Present",
    punchIn:  formatTime(first),
    punchOut: last ? formatTime(last) : null,
  };
}

/**
 * Join students (from DB) with biometric logs (from SmartOffice) by EmployeeCode.
 * @param {Array} students  Rows from `students` table
 * @param {Array} logs      Rows from SmartOffice API
 * @param {string} date     YYYY-MM-DD
 * @param {Set}   leaveSet  Set of student codes on leave that day
 * @param {Map}   overrideMap  Map of student_code → override row
 * @returns {Array} Enriched attendance records
 */
function buildAttendanceRecords(students, logs, date, leaveSet, overrideMap) {
  // Group logs by EmployeeCode
  const byCode = new Map();
  for (const log of logs) {
    const code = String(log.EmployeeCode).trim();
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(log);
  }

  return students.map((student) => {
    const code        = String(student.code).trim();
    const studentLogs = byCode.get(code) || [];
    const latestLog   = studentLogs[0] || null;

    let { status, punchIn, punchOut } = computeStatus(studentLogs);

    // Apply leave
    if (leaveSet && leaveSet.has(code)) {
      status   = "On Leave";
      punchIn  = null;
      punchOut = null;
    }

    // Apply manual override (wins over everything)
    const override = overrideMap && overrideMap.get(code);
    if (override) {
      if (override.status)    status   = override.status;
      if (override.punch_in)  punchIn  = override.punch_in;
      if (override.punch_out) punchOut = override.punch_out;
    }

    return {
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
      date,
      punchIn,
      punchOut,
      serialNumber:     latestLog?.SerialNumber     || "—",
      status,
      temperature:      latestLog?.Temperature      || null,
      temperatureState: latestLog?.TemperatureState || null,
      logCount:         studentLogs.length,
      manuallyEdited:   !!override,
    };
  });
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
};
