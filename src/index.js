// src/index.js
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const app = express();
const port = process.env.PORT || 5000;

/* ----------------------  Routers  ---------------------- */
const carsRouter = require("./routes/cars");
const customerAppointmentsRouter = require("./routes/customerAppointments");
const reconditionerCategoriesRouter = require("./routes/reconditionerCategories");
const reconditionerAppointmentsRouter = require("./routes/reconditionerAppointments");
const tasksRouter = require("./routes/tasks");
const photoRoutes = require("./routes/photoRoutes");
const reconIngestRoutes = require("./routes/reconIngest");

// Some optional routes might not export a router correctly,
// so we wrap them defensively:
function safeRequireRouter(path) {
  try {
    const mod = require(path);
    if (typeof mod === "function" || (mod && typeof mod.use === "function")) return mod;
    console.warn(`[WARN] ${path} did not export a router function.`);
    return express.Router();
  } catch (e) {
    console.warn(`[WARN] Failed to load ${path}:`, e.message);
    return express.Router();
  }
}

const carImportRouter = safeRequireRouter("./routes/carImport");
const autogateSyncRoutes = safeRequireRouter("./routes/autogateSync");

/* ----------------------  Auth ---------------------- */
const authRoutes = require("./routes/auth");
const requireAuth = require("./middleware/requireAuth");
const { resolveRegoController } = require("./routes/cars");

/* ----------------------  Telegram ---------------------- */
let bot = null;
try {
  ({ bot } = require("./bots/telegram"));
} catch (e) {
  console.warn("[telegram] unavailable:", e.message);
}

/* ----------------------  Setup ---------------------- */
app.set("trust proxy", 1);

const BASE_PAGES_HOST = "crai-frontend.pages.dev";
const FRONTEND_URLS = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    if (hostname === BASE_PAGES_HOST) return true;
    if (hostname.endsWith("." + BASE_PAGES_HOST)) return true;
    if (FRONTEND_URLS.includes(origin)) return true;
  } catch {}
  return false;
}

const corsConfig = {
  origin(origin, cb) {
    const ok = isAllowedOrigin(origin);
    if (!ok) console.warn(`[CORS] blocked origin: ${origin || "(none)"}`);
    cb(null, ok);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsConfig));
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(cookieParser());

/* ----------------------  Public endpoints ---------------------- */
app.get("/api/auth/debug-cookie", (req, res) => {
  res.json({
    origin: req.headers.origin || null,
    host: req.headers.host || null,
    forwardedProto: req.headers["x-forwarded-proto"] || null,
    cookies: req.cookies || {},
  });
});

app.get("/ping", (_req, res) => res.json({ ok: true, t: Date.now() }));
app.use("/api/auth", authRoutes);

/* ----------------------  Telegram webhook ---------------------- */
const TG_WEBHOOK_PATH = "/telegram/webhook";
const TG_WEBHOOK_DOMAIN = process.env.TELEGRAM_WEBHOOK_DOMAIN || "";
let stopTelegram = null;

if (bot) {
  app.post(
    TG_WEBHOOK_PATH,
    express.json({ limit: "2mb" }),
    (req, res, next) => {
      if (!bot?.webhookReply) return res.status(200).end();
      return require("./bots/telegram").bot.webhookCallback(TG_WEBHOOK_PATH)(
        req,
        res,
        next
      );
    }
  );
}

/* ----------------------  Public: Rego Resolver ---------------------- */
app.post("/api/cars/resolve-rego", resolveRegoController);

/* ----------------------  Protected Routes ---------------------- */
app.use("/api/cars", requireAuth, carsRouter);
app.use("/api/customer-appointments", requireAuth, customerAppointmentsRouter);
app.use("/api/reconditioner-categories", requireAuth, reconditionerCategoriesRouter);
app.use("/api/reconditioner-appointments", requireAuth, reconditionerAppointmentsRouter);
app.use("/api/tasks", requireAuth, tasksRouter);
app.use("/api/photos", requireAuth, photoRoutes);
app.use("/api/recon", requireAuth, reconIngestRoutes);

// ⚙️ Defensive guards for optional routes
app.use("/api/cars", requireAuth, carImportRouter);
app.use("/api/cars", requireAuth, autogateSyncRoutes);

/* ----------------------  Root + Errors ---------------------- */
app.get("/", (_req, res) => res.json({ message: "Welcome to CRAI Backend" }));
app.use((req, res) => res.status(404).json({ message: "Not Found" }));
app.use((err, _req, res, _next) => {
  console.error("Server error:", err.stack || err.message);
  res.status(500).json({ message: "Server error", error: err.message });
});

/* ----------------------  Startup ---------------------- */
async function start() {
  let server;
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    server = app.listen(port, () => {
      console.log(`🚀 Backend running on http://localhost:${port}`);
      console.log("CORS explicit FRONTEND_URLs:", FRONTEND_URLS);
      console.log(
        `CORS Pages host allowed: ${BASE_PAGES_HOST} and all *.${BASE_PAGES_HOST}`
      );
    });

    if (bot) {
      if (TG_WEBHOOK_DOMAIN) {
        const url = `https://${TG_WEBHOOK_DOMAIN}${TG_WEBHOOK_PATH}`;
        try {
          await bot.telegram.setWebhook(url);
          console.log(`[telegram] webhook set: ${url}`);
          stopTelegram = async () => {
            try {
              await bot.telegram.deleteWebhook();
              console.log("[telegram] webhook deleted");
            } catch (e) {
              console.warn("[telegram] deleteWebhook failed:", e.message);
            }
          };
        } catch (e) {
          console.error("[telegram] setWebhook failed, fallback to polling:", e.message);
          await bot.launch();
          console.log("[telegram] launched in polling mode (fallback)");
          stopTelegram = async () => bot.stop("SIGTERM");
        }
      } else {
        await bot.launch();
        console.log("[telegram] launched in polling mode");
        stopTelegram = async () => bot.stop("SIGTERM");
      }
    }

    const shutdown = async (signal) => {
      console.log(`\nReceived ${signal}, shutting down...`);
      try { if (stopTelegram) await stopTelegram(); } catch (e) { console.warn("Telegram stop error:", e.message); }
      try { if (mongoose.connection.readyState) await mongoose.disconnect(); } catch (e) { console.error("Mongo disconnect error:", e.message); }
      if (server) server.close(() => { console.log("HTTP server closed."); process.exit(0); });
      else process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    console.error("❌ Fatal startup error:", err.message);
    process.exit(1);
  }
}

start();
