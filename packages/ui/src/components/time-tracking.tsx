"use client"

import { formatMinutes } from "@knotworking/core"
import { Button } from "@knotworking/ui/components/button"
import { cn } from "@knotworking/ui/lib/utils"
import { Clock, Play, Square } from "lucide-react"
import * as React from "react"

/**
 * Logged time against a time estimate: "1h 30m / 4h" with a thin bar. Over the
 * estimate the figure and bar turn destructive. `compact` drops the bar (task rows).
 */
function TimeSummary({
  logged,
  estimate,
  compact = false,
  className,
}: {
  /** Finished minutes. */
  logged: number
  /** Time estimate in minutes, if any. */
  estimate?: number | null
  compact?: boolean
  className?: string
}) {
  const over = estimate != null && logged > estimate
  const ratio = estimate ? Math.min(1, logged / estimate) : 0
  const label = estimate
    ? `${formatMinutes(logged)} logged of ${formatMinutes(estimate)} estimated`
    : `${formatMinutes(logged)} logged`
  return (
    <span
      data-slot="time-summary"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums",
        className
      )}
    >
      <Clock className="size-3.5 shrink-0" aria-hidden />
      <span className={cn(over && "text-destructive")}>
        {formatMinutes(logged)}
        {estimate ? <span className="text-muted-foreground"> / {formatMinutes(estimate)}</span> : null}
      </span>
      {!compact && estimate ? (
        <span className="relative h-1 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span
            className={cn("absolute inset-y-0 left-0 rounded-full", over ? "bg-destructive" : "bg-primary")}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </span>
      ) : null}
    </span>
  )
}

/**
 * "0:04:05" style elapsed time since `since`, ticking every second. Null without `since`;
 * "…" until mounted, so server and client render the same text.
 */
function useElapsed(since: string | Date | null | undefined) {
  const [now, setNow] = React.useState<number | null>(null)
  const key = since ? new Date(since).getTime() : null
  React.useEffect(() => {
    if (key === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [key])
  if (!since) return null
  if (now === null) return "…"
  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000))
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

/**
 * Start/stop button for a timer. While `runningSince` is set it shows the elapsed time and
 * stops on click; otherwise it starts.
 */
function TimerButton({
  runningSince,
  onStart,
  onStop,
  disabled,
  className,
}: {
  runningSince?: string | Date | null
  onStart: () => void
  onStop: () => void
  disabled?: boolean
  className?: string
}) {
  const elapsed = useElapsed(runningSince)
  const running = Boolean(runningSince)
  return (
    <Button
      data-slot="timer-button"
      type="button"
      size="sm"
      variant={running ? "secondary" : "outline"}
      disabled={disabled}
      onClick={running ? onStop : onStart}
      aria-label={running ? `Stop timer (${elapsed})` : "Start timer"}
      className={cn("tabular-nums", className)}
    >
      {running ? <Square className="fill-current text-destructive" /> : <Play />}
      {running ? elapsed : "Start timer"}
    </Button>
  )
}

export { TimeSummary, TimerButton, useElapsed }
