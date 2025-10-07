// src/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();

// ---------- Config ----------
const JWT_SECRET = process.env.JWT_SECRET || "changeme"; // set real secret in prod
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || "Fast5";
const ALLOW_LOGIN_DEV = String(process.env.ALLOW_LOGIN_DEV || "").toLowerCase() === "true";

/** Compute cookie flags PER REQUEST so localhost & Pages both work */
function cookieOpts(req) {
  const origin = req.headers.origin || "";
  const host = req.headers.host || "";           // "localhost:5000" or "api.domain.com"
  const reqHostOnly = host.split(":")[0].toLowerCase();
  let originHostOnly = reqHostOnly;
  try { originHostOnly = new URL(origin).hostname.toLowerCase(); } catch {}
  const isCrossSite = originHostOnly !== reqHostOnly;
  const isHttps = req.secure || (req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
  const sameSite = isCrossSite ? "None" : "Lax";
  const secure = isHttps || sameSite === "None";
  return { httpOnly: true, secure, sameSite, path: "/", maxAge: 1000 * 60 * 60 * 8 };
}

function sign(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "8h" });
}

/** PUBLIC: sanity endpoint */
router.get("/ping", (req, res) => {
  const opts = cookieOpts(req);
  console.log("[/auth/ping] origin=%s host=%s sameSite=%s secure=%s", req.headers.origin, req.headers.host, opts.sameSite, opts.secure);
  res.json({
    ok: true,
    nodeEnv: process.env.NODE_ENV || null,
    cookie: { secure: !!opts.secure, sameSite: opts.sameSite },
    masterPasswordLen: (MASTER_PASSWORD || "").length,
    jwtSecretSet: JWT_SECRET !== "changeme",
    allowLoginDev: ALLOW_LOGIN_DEV,
  });
});

// POST /api/auth/login  { password }
router.post("/login", (req, res) => {
  try {
    const bodyKeys = req.body ? Object.keys(req.body) : [];
    console.log("[/login] origin=%s host=%s keys=%j", req.headers.origin, req.headers.host, bodyKeys);

    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ message: "Bad request: no JSON body" });
    }

    const raw = req.body.password ?? req.body.pass ?? req.body.code ?? "";
    const password = typeof raw === "string" ? raw.trim() : "";

    if (!password || password !== MASTER_PASSWORD) {
      return res.status(401).json({
        message: "Invalid password",
        hint: "Check MASTER_PASSWORD in backend env matches what you type.",
      });
    }

    const token = sign({ role: "user" });
    res.cookie("sid", token, cookieOpts(req)); // set cookie
    return res.status(200).json({ message: "ok", token });
  } catch (e) {
    console.error("Auth login error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Optional: DEV login to test cookie flow
router.post("/login-dev", (req, res) => {
  if (!ALLOW_LOGIN_DEV) return res.status(403).json({ message: "Disabled" });
  const token = sign({ role: "user", dev: true });
  res.cookie("sid", token, cookieOpts(req));
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
    res.clearCookie("sid", { ...cookieOpts(req), maxAge: 0 });
    return res.status(401).json({ message: "Session expired" });
  }
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  res.clearCookie("sid", { ...cookieOpts(req), maxAge: 0 });
  return res.json({ message: "bye" });
});

// Optional GET logout
router.get("/logout", (req, res) => {
  res.clearCookie("sid", { ...cookieOpts(req), maxAge: 0 });
  return res.json({ message: "bye" });
});

module.exports = router;
