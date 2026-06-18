/**
 * Biometric device routes
 *
 * POST /api/biometric/upload-user   — register a student on the biometric device
 */

const express = require("express");
const { query } = require("../config/db");

const router = express.Router();

const SMARTOFFICE_BASE = process.env.SMARTOFFICE_BASE_URL  || "http://13.232.199.167";
const API_KEY          = process.env.SMARTOFFICE_API_KEY   || "385619062612";
const DEFAULT_SERIAL   = process.env.SMARTOFFICE_SERIAL_NUMBER || "AMDB25121401560";

// ── POST /api/biometric/upload-user ──────────────────────────────────────────
router.post("/upload-user", async (req, res) => {
  const {
    studentCode,
    cardNumber,
    serialNumbers,
    verifyMode,
    isFaceUpload       = false,
    isFPUpload         = false,
    isCardUpload       = true,
    isBioPasswordUpload = false,
  } = req.body;

  if (!studentCode) {
    return res.status(400).json({
      success: false,
      error: "studentCode is required",
    });
  }

  // 1. Verify student exists in our DB
  const rows = await query("SELECT * FROM students WHERE code = ?", [studentCode]);
  if (!rows.length) {
    return res.status(404).json({
      success: false,
      error: `Student with code "${studentCode}" not found in database`,
    });
  }

  const student = rows[0];

  // 2. Call SmartOffice UploadUser API
  // Reference: POST /api/v2/WebAPI/UploadUser
  try {
    const serials = serialNumbers
      ? serialNumbers.split(",").map((s) => s.trim())
      : [DEFAULT_SERIAL];

    const results = [];

    for (const serial of serials) {
      const payload = {
        APIKey:              API_KEY,
        SerialNumber:        serial,
        EmployeeCode:        student.code,
        EmployeeName:        student.name,
        CardNumber:          cardNumber || "",
        VerifyMode:          verifyMode || "1",
        IsFaceUpload:        isFaceUpload,
        IsFPUpload:          isFPUpload,
        IsCardUpload:        isCardUpload,
        IsBioPasswordUpload: isBioPasswordUpload,
      };

      const url = `${SMARTOFFICE_BASE}/api/v2/WebAPI/UploadUser`;
      console.log(`[Biometric] Uploading ${studentCode} to device ${serial}`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      try {
        const response = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(payload),
          signal:  controller.signal,
        });
        clearTimeout(timer);

        const data = await response.json();
        results.push({ serial, success: data.status !== false, data });
      } catch (fetchErr) {
        clearTimeout(timer);
        results.push({
          serial,
          success: false,
          error: fetchErr.message,
        });
      }
    }

    const allSuccess = results.every((r) => r.success);
    return res.json({
      success: allSuccess,
      message: allSuccess
        ? `Student ${student.name} registered on ${results.length} device(s) successfully.`
        : `Partial success. Check the results array for details.`,
      results,
    });
  } catch (err) {
    console.error("[Biometric] POST /upload-user", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
