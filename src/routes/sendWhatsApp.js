const axios = require("axios");
const FormData = require("form-data");

const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL  || "https://api.rhaitech.online/api/create-message";
const APP_KEY          = process.env.WHATSAPP_APP_KEY   || process.env.WABA_APPKEY  || "63b954ad-a264-4f1a-bc06-738f3f8e0ea5";
const AUTH_KEY         = process.env.WHATSAPP_AUTH_KEY   || process.env.WABA_AUTHKEY || "Ly1rcczQU9gILsKa4qW8vvTIAQ63BEmNH4g64HJyi7xsziQR4J";

/**
 * Send a WhatsApp notification for a single biometric punch event.
 * @param {Object} log  A single SmartOffice log entry
 */
async function sendWhatsApp(log) {
  try {
    const studentName = log.EmployeeName || "Student";
    const status      = log.InOutMode === 0 ? "Present" : "Exited";
    const time        = new Date(log.LogDate || log.DateTime).toLocaleString("en-IN");

    const mobile = log.Mobile || log.ContactNumber;
    if (!mobile || mobile === "91XXXXXXXXXX") {
      console.log(`[WhatsApp] Skipped ${studentName} — no valid mobile number`);
      return;
    }

    // Clean mobile number
    let cleanMobile = String(mobile).replace(/\D/g, "");
    if (!cleanMobile.startsWith("91")) {
      cleanMobile = "91" + cleanMobile;
    }

    const form = new FormData();

    form.append("appkey",  APP_KEY);
    form.append("authkey", AUTH_KEY);
    form.append("to",      cleanMobile);

    form.append("template_id", "present");
    form.append("language",    "en");

    form.append("variables[{1}]", studentName);
    form.append("variables[{2}]", status);
    form.append("variables[{3}]", time);

    const response = await axios.post(WHATSAPP_API_URL, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });

    console.log(`[WhatsApp] ✅ Sent to ${studentName} (${cleanMobile})`);
    return response.data;
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.response?.data || err.message;

    // Handle rate-limiting: log a warning but don't crash
    if (typeof errorMsg === "string" && errorMsg.includes("Too Many Attempts")) {
      console.warn(`[WhatsApp] ⚠️ Rate-limited for ${log.EmployeeName || "Unknown"} — will retry later`);
    } else {
      console.error(`[WhatsApp] ❌ Failed for ${log.EmployeeName || "Unknown"}:`, errorMsg);
    }
  }
}

module.exports = sendWhatsApp;
