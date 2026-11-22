import { SidebarProvider } from "@knotworking/ui/components/sidebar";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMenu } from "./user-menu";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("@/lib/workspace-store", () => ({
  useWorkspace: () => ({ can: () => false, viewer: { role: "owner" } }),
}));

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

function openMenu() {
  render(
    <SidebarProvider>
      <UserMenu user={{ name: "Test user", email: "test@example.invalid" }} slug="demo" />
    </SidebarProvider>,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: /test user/i }), { button: 0, ctrlKey: false });
}

describe("desktop account actions", () => {
  it("does not show desktop controls in a browser", () => {
    openMenu();
    expect(screen.queryByText("Change server…")).toBeNull();
  });
  it("shows desktop controls in the Tauri window", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    openMenu();
    expect(screen.getByText("Change server…")).toBeTruthy();
    expect(screen.getByText("Reload")).toBeTruthy();
  });
});

it("hides the Labels settings link when Tasks is unavailable", () => {
  openMenu();
  expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
});
