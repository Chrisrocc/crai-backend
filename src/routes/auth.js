// src/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();

// ---------- Config ----------
const JWT_SECRET = process.env.JWT_SECRET || "changeme"; // set a real one in .env!
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || "Fast5";
const ALLOW_LOGIN_DEV = String(process.env.ALLOW_LOGIN_DEV || "").toLowerCase() === "true";

// Decide cookie attributes based on env.
// In prod (HTTPS / cross-site): MUST be SameSite=None; Secure
function cookieOpts() {
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      path: "/",
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    };
  }
  // Local dev over http://localhost
  return {
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 8,
  };
}

function sign(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "8h" });
}

/** Quick: confirm server auth config from the client */
router.get("/ping", (_req, res) => {
  const opts = cookieOpts();
  res.json({
    ok: true,
    nodeEnv: process.env.NODE_ENV || null,
    cookie: { secure: !!opts.secure, sameSite: opts.sameSite, path: opts.path, maxAge: opts.maxAge },
    masterPasswordLen: (MASTER_PASSWORD || "").length, // NO actual secret
    jwtSecretSet: JWT_SECRET !== "changeme",
    allowLoginDev: ALLOW_LOGIN_DEV,
  });
});

// ---------- Routes ----------

// POST /api/auth/login  { password }
router.post("/login", (req, res) => {
  try {
    // Sanity log (safe — does not print the password)
    console.log("[/login] NODE_ENV=%s, bodyKeys=%j", process.env.NODE_ENV, Object.keys(req.body || {}));

    // Make sure we got JSON parsed
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ message: "Bad request: no JSON body" });
    }

    const { password } = req.body;

    if (typeof password !== "string") {
      return res.status(400).json({ message: "Bad request: password must be a string" });
    }

    if (!password || password !== MASTER_PASSWORD) {
      // Helpful error (doesn't leak secrets)
      return res.status(401).json({
        message: "Invalid password",
        hint: "Check MASTER_PASSWORD in backend .env matches what you type",
      });
    }

    const token = sign({ role: "user" });

    // Keep backend cookie (so /api/auth/me works)
    res.cookie("sid", token, cookieOpts());

    return res.status(200).json({ message: "ok", token });
  } catch (e) {
    console.error("Auth login error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Optional DEV backdoor (enable only if ALLOW_LOGIN_DEV=true in .env)
// POST /api/auth/login-dev  { password? }  -> logs you in regardless (for debugging only)
router.post("/login-dev", (req, res) => {
  if (!ALLOW_LOGIN_DEV) return res.status(403).json({ message: "Disabled" });
  const token = sign({ role: "user", dev: true });
  res.cookie("sid", token, cookieOpts());
  return res.status(200).json({ message: "ok-dev", token });
});

// GET /api/auth/me
router.get("/me", (req, res) => {
  const token = req.cookies?.sid;
  if (!token) return res.status(401).json({ message: "Not logged in" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return res.json({ ok: true, user: { role: payload.role || "user" } });
  } catch {
    res.clearCookie("sid", { ...cookieOpts(), maxAge: 0 });
    return res.status(401).json({ message: "Session expired" });
  }
});

// POST /api/auth/logout
router.post("/logout", (_req, res) => {
  res.clearCookie("sid", { ...cookieOpts(), maxAge: 0 });
  return res.json({ message: "bye" });
});

// Optional: GET /api/auth/logout (handy for manual testing)
router.get("/logout", (_req, res) => {
  res.clearCookie("sid", { ...cookieOpts(), maxAge: 0 });
  return res.json({ message: "bye" });
});

module.exports = router;
