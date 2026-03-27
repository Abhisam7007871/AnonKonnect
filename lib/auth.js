import jwt from "jsonwebtoken";

const secret = process.env.JWT_SECRET || "anonkonnect-dev-secret";

export function signSessionToken(payload) {
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

export function verifySessionToken(token) {
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}
