"use client";

import { io } from "socket.io-client";

let socket;

export function getSocket(auth = {}) {
  if (!socket) {
    const fallbackSocketUrl =
      process.env.NEXT_PUBLIC_SOCKET_URL && String(process.env.NEXT_PUBLIC_SOCKET_URL).trim()
        ? process.env.NEXT_PUBLIC_SOCKET_URL
        : "https://anonkonnect-server.onrender.com";

    socket = io(fallbackSocketUrl, {
      // Polling first is more reliable on some hosts/CDNs; then upgrade to websocket.
      transports: ["polling", "websocket"],
      auth,
    });
  } else if (Object.keys(auth).length > 0) {
    socket.auth = auth;
  }

  return socket;
}

export function resetSocket() {
  if (socket) {
    socket.disconnect();
    socket = undefined;
  }
}
