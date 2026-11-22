import { describe, expect, it } from "vitest";
import { isStaffNumber, isWeakPin, nextStaffNumber, staffCreateSchema, staffUpdateSchema } from "./people";

describe("staff numbers", () => {
  it("are exactly six digits", () => {
    expect(isStaffNumber("000123")).toBe(true);
    expect(isStaffNumber("12345")).toBe(false);
    expect(isStaffNumber("1234567")).toBe(false);
    expect(isStaffNumber("12 456")).toBe(false);
  });

  it("suggest one above the highest, starting at 100001", () => {
    expect(nextStaffNumber([])).toBe("100001");
    expect(nextStaffNumber(["000042", "000043"])).toBe("100001");
    expect(nextStaffNumber(["100001", "100007", "100003"])).toBe("100008");
    expect(nextStaffNumber(["999999"])).toBe("000001");
    expect(nextStaffNumber(["999999", "000001"])).toBe("000002");
  });
});

describe("PINs", () => {
  it("refuse repeats, runs, repeated pairs and triples, and the staff number", () => {
    for (const pin of [
      "000000",
      "777777",
      "123456",
      "456789",
      "012345",
      "987654",
      "121212",
      "123123",
      "abcdef",
      "12345",
    ]) {
      expect(isWeakPin(pin), pin).toBe(true);
    }
    expect(isWeakPin("100001", "100001")).toBe(true);
  });

  it("accept ordinary PINs", () => {
    for (const pin of ["482915", "735190", "100002", "908172"])
      expect(isWeakPin(pin, "100001"), pin).toBe(false);
  });
});

describe("staff schemas", () => {
  it("trim names, blank optional text to null and check dates", () => {
    const parsed = staffCreateSchema.parse({ firstName: " Ada ", lastName: "Lovelace", department: "  " });
    expect(parsed).toMatchObject({ firstName: "Ada", department: null });
    expect(staffUpdateSchema.safeParse({ startDate: "2026-02-01", endDate: "2026-01-01" }).success).toBe(
      false,
    );
    expect(staffUpdateSchema.safeParse({}).success).toBe(false);
  });
});
