// src/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();

// ---------- Config ----------
const JWT_SECRET = process.env.JWT_SECRET || "changeme"; // set a real one in .env!
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || "Fast5";

// Decide cookie attributes based on env.
// In dev (localhost over http): secure=false, sameSite='lax' (or 'strict' if you prefer).
// In prod (HTTPS / different domain frontends): set COOKIE_SECURE=true and SAMESITE=none in env.
function cookieOpts() {
  const secure =
    String(process.env.COOKIE_SECURE || "").toLowerCase() === "true" ||
    process.env.NODE_ENV === "production";

  // valid values: 'lax' (default), 'strict', 'none'
  let sameSite = (process.env.SAMESITE || "lax").toLowerCase();
  if (sameSite === "none" && !secure) {
    // SameSite=None requires Secure.
    sameSite = "lax";
  }

  return {
    httpOnly: true,
    secure,                // true only when served via HTTPS
    sameSite,              // 'lax' by default; use 'none' with HTTPS across domains
    path: "/",
    maxAge: 1000 * 60 * 60 * 8, // 8 hours
  };
}

function sign(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "8h" });
}

// ---------- Routes ----------

// POST /api/auth/login  { password }
router.post("/login", (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || password !== MASTER_PASSWORD) {
      return res.status(401).json({ message: "Invalid password" });
    }
    const token = sign({ role: "user" });
    res.cookie("sid", token, cookieOpts());
    return res.json({ message: "ok" });
  } catch (e) {
    console.error("Auth login error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/auth/me
router.get("/me", (req, res) => {
  const token = req.cookies?.sid;
  if (!token) return res.status(401).json({ message: "Not logged in" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // if you want to return info later, add to payload when signing
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
