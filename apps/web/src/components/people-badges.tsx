import { staffStatusLabels, type StaffStatus } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { KeyRound, Lock } from "lucide-react";

/** Active or leaver. Active is the normal case, so it is quiet. */
export function StaffStatusBadge({ status }: { status: StaffStatus }) {
  return status === "active" ? (
    <Badge variant="outline">{staffStatusLabels.active}</Badge>
  ) : (
    <Badge className="border-transparent bg-label-gray-bg text-label-gray">{staffStatusLabels.leaver}</Badge>
  );
}

/** Whether a person can use the kiosk: PIN set, not set, or locked after wrong attempts. */
export function KioskPinBadge({ hasPin, lockedUntil }: { hasPin: boolean; lockedUntil: string | null }) {
  if (lockedUntil) {
    return (
      <Badge className="border-transparent bg-label-red-bg text-label-red">
        <Lock data-icon="inline-start" /> Locked
      </Badge>
    );
  }
  return hasPin ? (
    <Badge className="border-transparent bg-label-green-bg text-label-green">
      <KeyRound data-icon="inline-start" /> PIN set
    </Badge>
  ) : (
    <Badge variant="outline" className="border-dashed text-muted-foreground">
      No PIN
    </Badge>
  );
}

/** A 6-digit staff number, in a fixed-width face so columns line up. */
export function StaffNumber({ value }: { value: string }) {
  return <span className="font-mono text-sm tabular-nums">{value}</span>;
}
