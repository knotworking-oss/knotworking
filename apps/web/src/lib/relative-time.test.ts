import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

const now = Date.parse("2026-11-09T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000);
const DAY = 86_400;

describe("relativeTime", () => {
  it("shows a placeholder for missing values", () => {
    expect(relativeTime(null, now)).toBe("—");
    expect(relativeTime(undefined, now)).toBe("—");
    expect(relativeTime("", now)).toBe("—");
  });

  it("says 'just now' under a minute, in either direction", () => {
    expect(relativeTime(ago(0), now)).toBe("just now");
    expect(relativeTime(ago(59), now)).toBe("just now");
    expect(relativeTime(ago(-59), now)).toBe("just now");
  });

  it("picks the largest fitting unit for the past", () => {
    expect(relativeTime(ago(60), now)).toBe("1 minute ago");
    expect(relativeTime(ago(5 * 60), now)).toBe("5 minutes ago");
    expect(relativeTime(ago(3 * 3600), now)).toBe("3 hours ago");
    expect(relativeTime(ago(DAY), now)).toBe("yesterday");
    expect(relativeTime(ago(3 * DAY), now)).toBe("3 days ago");
    expect(relativeTime(ago(7 * DAY), now)).toBe("last week");
    expect(relativeTime(ago(21 * DAY), now)).toBe("3 weeks ago");
    expect(relativeTime(ago(60 * DAY), now)).toBe("2 months ago");
    expect(relativeTime(ago(400 * DAY), now)).toBe("last year");
    expect(relativeTime(ago(800 * DAY), now)).toBe("2 years ago");
  });

  it("handles the future", () => {
    expect(relativeTime(ago(-6 * DAY), now)).toBe("in 6 days");
    expect(relativeTime(ago(-DAY), now)).toBe("tomorrow");
    expect(relativeTime(ago(-2 * 3600), now)).toBe("in 2 hours");
  });

  it("accepts ISO strings and Date objects alike", () => {
    expect(relativeTime("2026-11-06T12:00:00Z", now)).toBe("3 days ago");
    expect(relativeTime(new Date("2026-11-06T12:00:00Z"), now)).toBe("3 days ago");
  });

  it("defaults to the current time", () => {
    expect(relativeTime(new Date(Date.now() - 2 * 3600 * 1000))).toBe("2 hours ago");
  });
});
