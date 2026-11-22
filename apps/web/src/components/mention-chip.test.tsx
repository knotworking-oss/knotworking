/** Mention chips: live names, links, and the muted "unavailable" chip, through DocRenderer and the provider. */
import { d } from "@knotworking/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "@/lib/workspace-store";
import { makeBootstrap, makeDoc, makeTask } from "@/test/fixtures";
import { DocRenderer } from "./doc-renderer";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/sync-push", () => ({ connectSyncPush: () => () => {} }));
vi.mock("@/lib/auth-client", () => ({
  browserApi: () => ({}),
  unwrap: async (p: unknown) => p,
  errorMessage: String,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const body = d.doc(
  d.p(
    "Ask ",
    d.mention("user", "u1", "Old name"),
    ", then ",
    d.mention("task", "t1", "Old task title"),
    " and ",
    d.mention("doc", "d1", "Old doc title"),
    ".",
  ),
);

const boot = makeBootstrap([makeTask({ id: "t1", title: "Fix login" })], {
  documents: [makeDoc({ id: "d1", title: "Runbook" })],
});

function mount(content = body) {
  return render(
    <WorkspaceProvider boot={boot} slug="acme" viewer={{ id: "u1", role: "member" }}>
      <DocRenderer content={content} />
    </WorkspaceProvider>,
  );
}

describe("mention chips", () => {
  it("show live names and link tasks and pages (people are a chip without a link)", () => {
    mount();
    expect(screen.getByText("Ada")).toBeDefined();
    expect(screen.queryByText("Old name")).toBeNull();
    expect(screen.getByRole("link", { name: "Fix login" }).getAttribute("href")).toBe("/acme/task/t1");
    expect(screen.getByRole("link", { name: "Runbook" }).getAttribute("href")).toBe("/acme/docs/d1");
    expect(screen.queryByRole("link", { name: "Ada" })).toBeNull();
  });

  it("render a deleted target as a muted unavailable chip, without a link", () => {
    const gone = d.doc(
      d.p(d.mention("task", "deleted-task", "Secret plan"), d.mention("doc", "deleted-doc", "Old page")),
    );
    const { container } = mount(gone);
    expect(screen.getByText("Unavailable task")).toBeDefined();
    expect(screen.getByText("Unavailable page")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
    const chips = container.querySelectorAll("[data-mention-unavailable]");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.getAttribute("title")).toBe("Secret plan (no longer available)");
    expect(chips[0]!.className).toContain("text-muted-foreground");
  });

  it("fall back to the cached label, unlinked, outside a workspace", () => {
    render(<DocRenderer content={body} />);
    expect(screen.getByText("Old task title")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
