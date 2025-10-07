// src/index.js
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieParser = require("cookie-parser");

// Routers
const carsRouter = require("./routes/cars");
const customerAppointmentsRouter = require("./routes/customerAppointments");
const reconditionerCategoriesRouter = require("./routes/reconditionerCategories");
const reconditionerAppointmentsRouter = require("./routes/reconditionerAppointments");
const tasksRouter = require("./routes/tasks");
const photoRoutes = require("./routes/photoRoutes");
const reconIngestRoutes = require("./routes/reconIngest");
const carImportRouter = require("./routes/carImport");
const autogateSyncRoutes = require("./routes/autogateSync");

// Auth
const authRoutes = require("./routes/auth");
const requireAuth = require("./middleware/requireAuth");

const app = express();
const port = process.env.PORT || 5000;

// Trust proxy so secure cookies + X-Forwarded-* work behind Railway
app.set("trust proxy", 1);

/* --------------------------  C O R S  -------------------------- */
// Base Cloudflare Pages host (production) — change if you rename the project
const BASE_PAGES_HOST = "crai-frontend.pages.dev";

// Optional explicit origins from env (comma-separated)
const FRONTEND_URLS = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  try {
    const u = new URL(origin);
    const host = u.hostname;

    // Allow production host
    if (host === BASE_PAGES_HOST) return true;

    // Allow ANY preview subdomain like 8343bbd8.crai-frontend.pages.dev
    if (host.endsWith("." + BASE_PAGES_HOST)) return true;

    // Allow anything explicitly listed in FRONTEND_URL
    if (FRONTEND_URLS.includes(origin)) return true;

    return false;
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin(origin, cb) {
      // allow curl/Postman/no-origin
      if (!origin) return cb(null, true);
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error(`CORS: Origin ${origin} not allowed`));
    },
    credentials: true,
    optionsSuccessStatus: 204, // preflight OK for Safari/Brave
  })
);
/* --------------------------------------------------------------- */

// Body + cookies
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health
app.get("/ping", (_req, res) => res.json({ ok: true, t: Date.now() }));

// Public routes
app.use("/api/auth", authRoutes);

// Protected routes
app.use("/api", requireAuth);
app.use("/api/cars", carsRouter);
app.use("/api/customer-appointments", customerAppointmentsRouter);
app.use("/api/reconditioner-categories", reconditionerCategoriesRouter);
app.use("/api/reconditioner-appointments", reconditionerAppointmentsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/photos", photoRoutes);
app.use("/api/recon", reconIngestRoutes);
app.use("/api/cars", carImportRouter);
app.use("/api/cars", autogateSyncRoutes);

// Root
app.get("/", (_req, res) => res.json({ message: "Welcome to CRAI Backend" }));

// 404
app.use((req, res) => res.status(404).json({ message: "Not Found" }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error("Server error:", err.stack || err.message);
  res.status(500).json({ message: "Server error", error: err.message });
});

async function start() {
  let server;
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    server = app.listen(port, () => {
      console.log(`Backend running on http://localhost:${port}`);
      console.log("CORS explicit FRONTEND_URLs:", FRONTEND_URLS);
      console.log(`CORS Pages host allowed: ${BASE_PAGES_HOST} and all *.${BASE_PAGES_HOST}`);
    });

    // Telegram bot (unchanged)
    const disableBot = String(process.env.DISABLE_BOT || "").toLowerCase() === "true";
    if (!disableBot && process.env.TELEGRAM_BOT_TOKEN) {
      const { bot } = require("./bots/telegram");
      try { await bot.telegram.deleteWebhook(); } catch (e) { console.warn("deleteWebhook warning:", e.message); }
      await bot.launch();
      console.log("🤖 CarYardBot running (polling)");
    } else {
      console.log("Telegram bot disabled or token not set.");
    }

    const shutdown = async (signal) => {
      console.log(`\nReceived ${signal}, shutting down...`);
      try { if (mongoose.connection.readyState) await mongoose.disconnect(); } catch (e) {
        console.error("Mongo disconnect error:", e.message);
      }
      if (server) server.close(() => {
        console.log("HTTP server closed.");
        process.exit(0);
      });
      else process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    console.error("Fatal startup error:", err.message);
    process.exit(1);
  }
}

start();
