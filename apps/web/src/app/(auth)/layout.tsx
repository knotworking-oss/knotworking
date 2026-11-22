import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="flex items-center gap-2 font-semibold">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-sm text-primary-foreground">
          T
        </span>
        Knotworking
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
