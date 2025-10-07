// src/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();

// ---------- Config ----------
const JWT_SECRET = process.env.JWT_SECRET || "changeme"; // set a real one in .env!
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || "Fast5";

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

// ---------- Routes ----------

// POST /api/auth/login  { password }
router.post("/login", (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || password !== MASTER_PASSWORD) {
      return res.status(401).json({ message: "Invalid password" });
    }

    const token = sign({ role: "user" });

    // Keep backend cookie (so /api/auth/me works)
    res.cookie("sid", token, cookieOpts());

    // ALSO return token (useful if you later add a CF Pages Function to set a 1P cookie)
    return res.status(200).json({ message: "ok", token });
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
