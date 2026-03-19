import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatRelativeClock(targetTs) {
  const delta = Math.max(0, Math.ceil((targetTs - Date.now()) / 1000));
  const minutes = String(Math.floor(delta / 60)).padStart(2, "0");
  const seconds = String(delta % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function toTitleCase(value) {
  return (value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}
