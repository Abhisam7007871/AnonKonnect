import { Check, CheckCheck, Lock } from "lucide-react";

import { cn } from "@/lib/utils";

export function ChatBubble({ message, isOwn, isBlurred }) {
  return (
    <div className={cn("flex animate-slideIn", isOwn ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] rounded-3xl border px-4 py-3 shadow-glass",
          isOwn
            ? "border-electric/30 bg-electric/15 text-slate-900"
            : "border-slate-200/80 bg-white text-slate-900",
        )}
      >
        <div className={cn("space-y-2", isBlurred && "select-none blur-sm")}>
          {message.kind === "text" && <p className="text-sm leading-6">{message.content}</p>}
          {message.kind === "sticker" && <p className="text-5xl leading-none">{message.content}</p>}
          {message.kind === "gif" && (
            <div className="overflow-hidden rounded-2xl border border-white/10">
              <img alt="GIF attachment" className="max-h-64 w-full object-cover" src={message.content} />
            </div>
          )}
          {message.kind === "image" && (
            <div className="overflow-hidden rounded-2xl border border-white/10">
              <img alt="Shared attachment" className="max-h-72 w-full object-cover" src={message.content} />
            </div>
          )}
          {message.kind === "voice" && (
            <audio controls className="h-10 w-full">
              <source src={message.content} />
            </audio>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-500">
          <span>{message.senderName}</span>
          <span className="inline-flex items-center gap-1">
            {isBlurred && <Lock className="h-3.5 w-3.5" />}
            {isOwn &&
              (message.readAt ? <CheckCheck className="h-3.5 w-3.5 text-aqua" /> : <Check className="h-3.5 w-3.5" />)}
          </span>
        </div>
      </div>
    </div>
  );
}
