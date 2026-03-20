const jwt = require("jsonwebtoken");

const secret = process.env.JWT_SECRET || "anonkonnect-dev-secret";

function verifySocketSessionToken(token) {
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

function normalizeGuestUser(auth = {}, socketId) {
  const profile = auth.user || {};
  return {
    id: null,
    nickname: profile.nickname || "Guest",
    accessLevel: "guest",
    gender: profile.gender || "",
    purpose: profile.purpose || "chat",
    country: profile.country || "United States",
    state: profile.state || "",
    city: profile.city || "",
    socketId,
  };
}

function normalizeRegisteredUser(session, socketId) {
  return {
    id: session.id,
    email: session.email,
    phone: session.phone || "",
    nickname: session.nickname || "Member",
    accessLevel: "registered",
    gender: session.gender || "",
    purpose: session.purpose || "chat",
    country: session.country || "United States",
    state: session.state || "",
    city: session.city || "",
    socketId,
  };
}

module.exports = {
  verifySocketSessionToken,
  normalizeGuestUser,
  normalizeRegisteredUser,
};
