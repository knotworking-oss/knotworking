import { Badge } from "@knotworking/ui/components/badge";
import { Switch } from "@knotworking/ui/components/switch";
import { formatDateTime } from "@/lib/format";

export interface TokenActionRowData {
  id: string;
  label: string;
  description: string;
  level: "write" | "manage";
  enabled: boolean;
  enabledBy: string | null;
  enabledAt: string | null;
}

/** One toggleable action under Settings → API access: what it allows, what it needs, and its switch. */
export function TokenActionRow({
  action,
  canManage,
  pending = false,
  onToggle,
  timeZone,
}: {
  action: TokenActionRowData;
  canManage: boolean;
  pending?: boolean;
  onToggle: (enabled: boolean) => void;
  /** The workspace's time zone, for when the action was allowed. */
  timeZone?: string;
}) {
  const switchId = `token-action-${action.id}`;
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={switchId} className="text-sm font-medium">
            {action.label}
          </label>
          <Badge variant="outline" className="font-normal">
            Needs {action.level} access
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{action.description}</p>
        {action.enabled && action.enabledAt && (
          <p className="text-xs text-muted-foreground">
            Allowed{action.enabledBy ? ` by ${action.enabledBy}` : ""} ·{" "}
            {formatDateTime(action.enabledAt, timeZone)}
          </p>
        )}
      </div>
      <Switch
        id={switchId}
        checked={action.enabled}
        disabled={!canManage || pending}
        onCheckedChange={onToggle}
        className="mt-0.5"
      />
    </div>
  );
}

/** Result of an audited token call: 2xx is "ok", anything else shows its HTTP status. */
export function ResultBadge({ status }: { status: number }) {
  const ok = status >= 200 && status < 300;
  return (
    <Badge
      variant={ok ? "secondary" : "destructive"}
      className="tabular-nums"
      aria-label={ok ? `Succeeded (${status})` : `Refused or failed (${status})`}
    >
      {ok ? "ok" : status}
    </Badge>
  );
}
