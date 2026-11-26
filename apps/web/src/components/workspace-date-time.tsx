"use client";

import { useFormatDateTime } from "@/lib/workspace-time";

/** A timestamp in the workspace's time zone ("—" when empty), for server-rendered pages. */
export function WorkspaceDateTime({ value }: { value: string | null | undefined }) {
  const format = useFormatDateTime();
  return <>{value ? format(value) : "—"}</>;
}
