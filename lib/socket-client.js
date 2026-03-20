"use client";

import { io } from "socket.io-client";

let socket;
let socketUrlUsed;

export function getSocketUrl() {
  const trimmed = process.env.NEXT_PUBLIC_SOCKET_URL
    ? String(process.env.NEXT_PUBLIC_SOCKET_URL).trim()
    : "";

  return trimmed || "https://anonkonnect-server.onrender.com";
}

export function getSocket(auth = {}) {
  if (!socket) {
    const socketUrl = getSocketUrl();
    socketUrlUsed = socketUrl;

    socket = io(socketUrl, {
      // Polling first is more reliable on some hosts/CDNs; then upgrade to websocket.
      transports: ["polling", "websocket"],
      auth,
    });
  } else if (Object.keys(auth).length > 0) {
    socket.auth = auth;
  }

  // If a wrong URL was used earlier in this same runtime, rebuild the socket.
  // This prevents being stuck on e.g. `wss://<site>/socket.io` when we intended the backend.
  const currentUrl = getSocketUrl();
  if (socket && socketUrlUsed && currentUrl !== socketUrlUsed) {
    socket.disconnect();
    socket = undefined;
    socketUrlUsed = undefined;
    return getSocket(auth);
  }

  return socket;
}

export function resetSocket() {
  if (socket) {
    socket.disconnect();
    socket = undefined;
  }
}
