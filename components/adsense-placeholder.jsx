import { Megaphone } from "lucide-react";

import { cn } from "@/lib/utils";

export function AdSensePlaceholder({ className, label }) {
  return (
    <div
      className={cn(
        "rounded-3xl border border-slate-200/80 bg-white/80 p-4 text-sm text-slate-600 backdrop-blur-xl",
        className,
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.32em] text-slate-500">
        <Megaphone className="h-4 w-4" />
        <span>AdSense Placeholder</span>
      </div>
      <p className="font-medium text-slate-900">{label}</p>
      <p className="mt-1 text-xs text-slate-500">
        Reserve this slot for monetized inventory without disrupting the premium glass layout.
      </p>
    </div>
  );
}
