require("dotenv").config();

const express    = require("express");
const cors       = require("cors");
const { initDb } = require("./config/db");

// ─── Routes ───────────────────────────────────────────────────────────────────
const attendanceRouter = require("./routes/attendance");
const studentsRouter   = require("./routes/students");
const biometricRouter  = require("./routes/biometric");

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ───────────────────────────────────────────────────────────────

// CORS — allow the Next.js frontend to call this API
app.use(
  cors({
    origin: [
      process.env.FRONTEND_ORIGIN || "https://absolutefoundationattendance.vercel.app",
      // Add your production domain here when deploying
      // "https://your-frontend.com",
    ],
    methods:     ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logger (lightweight)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status:  "ok",
    service: "Absolute Foundation Attendance API",
    time:    new Date().toISOString(),
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/attendance", attendanceRouter);
app.use("/api/students",   studentsRouter);
app.use("/api/biometric",  biometricRouter);

// ─── START SERVER ─────────────────────────────────────────
/* app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // ✅ ADD THIS HERE
  require("./routes/attendanceWatcher");
}); */

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Route not found" });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[Server Error]", err);
  res.status(500).json({
    success: false,
    error:   err.message || "Internal server error",
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    // Auto-create DB tables on startup
    await initDb();

    app.listen(PORT, () => {
       require("./routes/attendanceWatcher");
      console.log("─────────────────────────────────────────────────────");
      console.log(`  Attendance Backend running on http://localhost:${PORT}`);
      console.log("─────────────────────────────────────────────────────");
      console.log(`  Health:     GET  http://localhost:${PORT}/api/health`);
      console.log(`  Students:   GET  http://localhost:${PORT}/api/students`);
      console.log(`  Attendance: GET  http://localhost:${PORT}/api/attendance?date=YYYY-MM-DD`);
      console.log(`  Sync:       POST http://localhost:${PORT}/api/attendance/sync`);
      console.log("─────────────────────────────────────────────────────");
    });
  } catch (err) {
    console.error("[Boot] Failed to start server:", err.message);
    console.error("       Check your DATABASE_URL / DB_* env variables in backend/.env");
    process.exit(1);
  }
}

start();
