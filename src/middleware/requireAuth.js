// src/middleware/requireAuth.js
const jwt = require("jsonwebtoken");
const COOKIE_NAME = "sid";

module.exports = function requireAuth(req, res, next) {
  try {
    const fromCookie = req.cookies?.[COOKIE_NAME];
    const auth = req.headers.authorization || "";
    const fromHeader = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    const token = fromCookie || fromHeader;
    if (!token) return res.status(401).json({ message: "Unauthorized" });

    req.user = jwt.verify(token, process.env.JWT_SECRET || "changeme");
    return next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
};
