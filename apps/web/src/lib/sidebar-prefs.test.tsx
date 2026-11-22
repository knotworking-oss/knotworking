import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  parseRecent,
  pushRecent,
  readCookie,
  recordRecentDoc,
  useDefaultArea,
  useRecentDocIds,
} from "./sidebar-prefs";

beforeEach(() => {
  window.localStorage.clear();
  for (const c of document.cookie.split(";")) document.cookie = `${c.split("=")[0]}=; path=/; max-age=0`;
});

describe("recent docs", () => {
  it("puts the newest first without repeats and keeps a bounded list", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a"], "z", 2)).toEqual(["z", "a"]);
    expect(pushRecent(["a", "b"], "z", 2)).toEqual(["z", "a"]);
  });

  it("reads bad storage as empty", () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("{")).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent('["a",3,"b"]')).toEqual(["a", "b"]);
  });

  it("records opened docs per person and workspace, and updates mounted lists", () => {
    const mine = renderHook(() => useRecentDocIds("u1", "acme"));
    const other = renderHook(() => useRecentDocIds("u2", "acme"));
    const elsewhere = renderHook(() => useRecentDocIds("u1", "beta"));
    expect(mine.result.current).toEqual([]);
    act(() => recordRecentDoc("u1", "acme", "d1"));
    act(() => recordRecentDoc("u1", "acme", "d2"));
    act(() => recordRecentDoc("u1", "acme", "d1"));
    expect(mine.result.current).toEqual(["d1", "d2"]);
    expect(other.result.current).toEqual([]);
    expect(elsewhere.result.current).toEqual([]);
  });
});

describe("default module", () => {
  it("is stored in a cookie the server can read, and cleared with null", () => {
    const { result } = renderHook(() => useDefaultArea("acme", null));
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]("items"));
    expect(result.current[0]).toBe("items");
    expect(readCookie("knw_home_acme")).toBe("items");
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    expect(readCookie("knw_home_acme")).toBeNull();
  });

  it("is per workspace", () => {
    const a = renderHook(() => useDefaultArea("acme", null));
    const b = renderHook(() => useDefaultArea("beta", null));
    act(() => a.result.current[1]("docs"));
    expect(b.result.current[0]).toBeNull();
  });
});
