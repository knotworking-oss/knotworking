import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoDistributionImpact } from "@/app/design/demo-records";
import { DistributionImpact } from "./distribution-impact";

describe("distribution impact coverage", () => {
  it("does not imply customers are unaffected when a limited trace found no deliveries", () => {
    render(<DistributionImpact slug="acme" report={demoDistributionImpact} timeZone="Europe/London" />);
    expect(screen.getByRole("alert").textContent).toContain("Partial recorded trace");
    expect(screen.getByRole("alert").textContent).toContain(
      "further production or customer-return links remain",
    );
    expect(screen.getByText(/This does not establish that no customers are affected/)).toBeTruthy();
    expect(screen.queryByText("Recorded trace fully followed")).toBeNull();
  });
  it("distinguishes a fully followed recorded trace from the absence of any delivery records", () => {
    render(
      <DistributionImpact
        slug="acme"
        report={{
          ...demoDistributionImpact,
          coverage: { ...demoDistributionImpact.coverage, status: "complete", reasons: [] },
        }}
        timeZone="Europe/London"
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Recorded trace fully followed");
    expect(screen.getByText(/No confirmed customer deliveries recorded/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
