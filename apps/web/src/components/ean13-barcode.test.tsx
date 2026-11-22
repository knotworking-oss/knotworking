import { ean13Pattern } from "@knotworking/core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Ean13Barcode } from "./ean13-barcode";

describe("EAN-13 barcode", () => {
  it("draws the bars of the symbol and the digits underneath", () => {
    const { container } = render(<Ean13Barcode gtin="5901234123457" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe("EAN-13 barcode 5901234123457");
    // Quiet zones: 11 + 95 + 7 modules.
    expect(svg.getAttribute("viewBox")!.split(" ")[2]).toBe("113");
    const bars = [...svg.querySelectorAll("rect")].slice(1);
    const pattern = ean13Pattern("5901234123457");
    const covered = [...pattern].map((_, i) =>
      bars.some((b) => {
        const x = Number(b.getAttribute("x"));
        return i + 11 >= x && i + 11 < x + Number(b.getAttribute("width"));
      })
        ? "1"
        : "0",
    );
    expect(covered.join("")).toBe(pattern);
    expect([...svg.querySelectorAll("text")].map((t) => t.textContent).join("")).toBe("5901234123457");
    // The guard bars are longer than the others.
    expect(new Set(bars.map((b) => b.getAttribute("height"))).size).toBe(2);
  });

  it("shows only the number when it is not a valid EAN-13", () => {
    const { container } = render(<Ean13Barcode gtin="5901234123450" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("5901234123450");
  });
});
