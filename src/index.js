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

// Public controller for rego resolution (no auth)
const { resolveRegoController } = require("./routes/cars");

// Telegram (do NOT launch here; we decide polling vs webhook below)
let bot = null;
try {
  ({ bot } = require("./bots/telegram"));
} catch (e) {
  console.warn("[telemetry] telegram bot unavailable:", e.message);
}

const app = express();
const port = process.env.PORT || 5000;

// Trust proxy so secure cookies work behind proxies (Railway/CF/Render)
app.set("trust proxy", 1);

/* --------------------------  C O R S  -------------------------- */
const BASE_PAGES_HOST = "crai-frontend.pages.dev";
const FRONTEND_URLS = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl/Postman/same-origin
  try {
    const { hostname } = new URL(origin);
    if (hostname === BASE_PAGES_HOST) return true;
    if (hostname.endsWith("." + BASE_PAGES_HOST)) return true; // CF preview subdomains
    if (FRONTEND_URLS.includes(origin)) return true; // explicit allow-list
  } catch {}
  return false;
}

const corsConfig = {
  origin(origin, cb) {
    const ok = isAllowedOrigin(origin);
    if (!ok) console.warn(`[CORS] blocked origin: ${origin || "(none)"}`);
    return cb(null, ok);
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
/* --------------------------------------------------------------- */

// Body + cookies
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Quick cookie/auth debug (PUBLIC)
app.get("/api/auth/debug-cookie", (req, res) => {
  res.json({
    origin: req.headers.origin || null,
    host: req.headers.host || null,
    forwardedProto: req.headers["x-forwarded-proto"] || null,
    cookies: req.cookies || {},
  });
});

// Health (PUBLIC)
app.get("/ping", (_req, res) => res.json({ ok: true, t: Date.now() }));

// --- PUBLIC AUTH ROUTES ---
app.use("/api/auth", authRoutes);

/* -------------------- TELEGRAM WEBHOOK (PUBLIC) -------------------- */
const TG_WEBHOOK_PATH = "/telegram/webhook";
const TG_WEBHOOK_DOMAIN = process.env.TELEGRAM_WEBHOOK_DOMAIN || ""; // e.g. crai-backend-production.up.railway.app
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
// -------------------------------------------------------------------

/* ------------------- PUBLIC: resolve-rego route ------------------- */
/**
 * NOTE: This must come BEFORE the auth-protected /api/cars routes,
 * otherwise the bot (no cookies) will get 401.
 */
app.post("/api/cars/resolve-rego", resolveRegoController);
/* ------------------------------------------------------------------ */

// --- PROTECTED ROUTES ---
app.use("/api/cars", requireAuth, carsRouter);
app.use("/api/customer-appointments", requireAuth, customerAppointmentsRouter);
app.use("/api/reconditioner-categories", requireAuth, reconditionerCategoriesRouter);
app.use("/api/reconditioner-appointments", requireAuth, reconditionerAppointmentsRouter);
app.use("/api/tasks", requireAuth, tasksRouter);
app.use("/api/photos", requireAuth, photoRoutes);
app.use("/api/recon", requireAuth, reconIngestRoutes);
app.use("/api/cars", requireAuth, carImportRouter);
app.use("/api/cars", requireAuth, autogateSyncRoutes);

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
          console.error("[telegram] setWebhook failed, falling back to polling:", e.message);
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
    console.error("Fatal startup error:", err.message);
    process.exit(1);
  }
}

start();
