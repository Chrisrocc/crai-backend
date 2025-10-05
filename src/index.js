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

// If you're behind a proxy / load balancer (Render, Fly, Heroku, etc.)
// this makes Express trust X-Forwarded-* headers (needed for secure cookies in prod)
app.set("trust proxy", 1);

// --- CORS ---
// Support single or comma-separated FRONTEND_URL list
const FRONTEND_URLS = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin: function (origin, cb) {
      // Allow no-origin requests like curl/Postman or same-origin
      if (!origin) return cb(null, true);
      if (FRONTEND_URLS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: Origin ${origin} not allowed`), false);
    },
    credentials: true, // allow cookies
  })
);

// Body + cookies
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health
app.get("/ping", (_req, res) => res.json({ ok: true, t: Date.now() }));

// --- Public routes ---
app.use("/api/auth", authRoutes);

// --- Protected routes ---
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

// Root welcome
app.get("/", (_req, res) => res.json({ message: "Welcome to CRAI Backend" }));

// 404
app.use((req, res) => {
  res.status(404).json({ message: "Not Found" });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error("Server error:", err.stack || err.message);
  // CORS errors show up here when origin is not allowed
  res.status(500).json({ message: "Server error", error: err.message });
});

async function start() {
  let server;
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    server = app.listen(port, () => {
      console.log(`Backend running on http://localhost:${port}`);
      console.log("CORS allowed origins:", FRONTEND_URLS.join(", "));
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
      try {
        if (mongoose.connection.readyState) await mongoose.disconnect();
      } catch (e) {
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
