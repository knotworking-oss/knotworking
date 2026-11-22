import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFormatDateTime, useWorkspaceTimeZone } from "./workspace-time";

describe("workspace time hooks", () => {
  it("fall back to the default zone outside a workspace", () => {
    expect(renderHook(() => useWorkspaceTimeZone()).result.current).toBe("Europe/London");
  });

  it("format a timestamp in the workspace zone, not the browser's", () => {
    const { result } = renderHook(() => useFormatDateTime());
    // 23:30 UTC on a summer evening is already after midnight in London.
    expect(result.current("2026-07-15T23:30:00Z")).toBe("16/07/2026 00:30 BST");
    expect(result.current(null)).toBe("");
  });
});
