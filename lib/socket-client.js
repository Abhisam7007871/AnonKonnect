"use client";

import { io } from "socket.io-client";

let socket;

export function getSocket(auth = {}) {
  if (!socket) {
    socket = io(process.env.NEXT_PUBLIC_SOCKET_URL || undefined, {
      transports: ["websocket", "polling"],
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
