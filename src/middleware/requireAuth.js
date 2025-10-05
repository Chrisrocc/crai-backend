const jwt = require("jsonwebtoken");
const COOKIE_NAME = "sid";

module.exports = function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ message: "Unauthorized" });
  try {
    jwt.verify(token, process.env.JWT_SECRET || "changeme");
    next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
};
