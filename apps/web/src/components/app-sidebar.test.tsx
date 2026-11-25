/**
 * The module-based sidebar: it shows the sections of one module, switches module from the workspace
 * header, lists the last five docs opened here, and remembers a starred default module.
 */
import { SidebarProvider } from "@knotworking/ui/components/sidebar";
import { TooltipProvider } from "@knotworking/ui/components/tooltip";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap } from "@/lib/api";
import { readCookie } from "@/lib/sidebar-prefs";
import { WorkspaceProvider } from "@/lib/workspace-store";
import { makeBootstrap, makeDoc } from "@/test/fixtures";
import { AppSidebar } from "./app-sidebar";

const mocks = vi.hoisted(() => ({ push: vi.fn(), pathname: "/acme/my-tasks" }));

vi.mock("next/navigation", () => {
  const router = { push: mocks.push, refresh: vi.fn() };
  return { useRouter: () => router, usePathname: () => mocks.pathname };
});
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
  unwrap: async (x: unknown) => x,
  errorMessage: String,
}));
vi.mock("./user-menu", () => ({ UserMenu: () => <div>user menu</div> }));
vi.mock("./new-task-dialog", () => ({ useNewTask: () => () => {} }));

Element.prototype.scrollIntoView = () => {};
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
}));

const modules = (ids: [string, "read" | "write" | "manage" | "none"][]) =>
  ids.map(([id, access]) => ({ id, name: id, description: "", dependsOn: [], enhancedBy: [], access }));

const docs = Array.from({ length: 7 }, (_, i) =>
  makeDoc({ id: `d${i + 1}`, title: `Doc ${i + 1}`, sortOrder: `a${i}` }),
);

function mount(opts: { boot?: Partial<Bootstrap>; initialDefaultArea?: string | null } = {}) {
  const boot = makeBootstrap([], {
    modules: modules([
      ["tasks", "write"],
      ["docs", "write"],
      ["items", "write"],
      ["haccp", "none"],
      ["time", "write"],
    ]),
    documents: docs,
    ...opts.boot,
  } as Partial<Bootstrap>);
  return render(
    <WorkspaceProvider boot={boot} slug="acme" viewer={{ id: "u1", role: "member" }}>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar
            workspace={{ slug: "acme", name: "Acme", icon: null }}
            user={{ name: "Ada", email: "ada@example.com" }}
            teams={[{ id: "team-1", key: "ENG", name: "Engineering", icon: null, openCount: 2 }]}
            myTaskCount={3}
            unreadCount={0}
            initialDefaultArea={opts.initialDefaultArea ?? null}
            initialLastArea={null}
            initialTeamsCollapsed={false}
          />
        </SidebarProvider>
      </TooltipProvider>
    </WorkspaceProvider>,
  );
}

const links = () => screen.getAllByRole("link").map((a) => a.getAttribute("href"));

beforeEach(() => {
  mocks.push.mockClear();
  mocks.pathname = "/acme/my-tasks";
  window.localStorage.clear();
  for (const c of document.cookie.split(";")) document.cookie = `${c.split("=")[0]}=; path=/; max-age=0`;
});

describe("AppSidebar", () => {
  it("shows the shared workspace avatar and omits the design system link", () => {
    const icon =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAAAAADH8yjkAAAAIElEQVR4nO3BgQAAAADDoPlTX+AIVQEAAAAAAAAAAHQNJGAAAQbH8O4AAAAASUVORK5CYII=";
    mount({ boot: { workspace: { ...makeBootstrap().workspace, icon } } });
    const header = screen.getByRole("button", { name: /Acme.*Switch module/ });
    expect(header.querySelector("img")?.getAttribute("src")).toBe(icon);
    expect(links()).not.toContain("/design");
  });

  it("always shows task planning, teams, the calendar and the wiki, whichever module is showing", () => {
    for (const pathname of ["/acme/my-tasks", "/acme/items", "/acme/inbox"]) {
      mocks.pathname = pathname;
      const view = mount({
        boot: {
          modules: modules([
            ["tasks", "write"],
            ["docs", "write"],
            ["calendar", "write"],
            ["items", "write"],
          ]),
        } as Partial<Bootstrap>,
      });
      for (const href of [
        "/acme/my-tasks",
        "/acme/projects",
        "/acme/team/ENG",
        "/acme/calendar",
        "/acme/docs",
      ]) {
        expect(links(), `${href} on ${pathname}`).toContain(href);
      }
      view.unmount();
    }
  });

  it("folds the teams list away and back, and remembers it", () => {
    mount();
    const toggle = screen.getByRole("button", { name: "Teams" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(links()).not.toContain("/acme/team/ENG");
    expect(screen.getByRole("button", { name: "Teams" }).getAttribute("aria-expanded")).toBe("false");
    expect(readCookie("knw_teams_acme")).toBe("1");
    // My tasks and Projects are not part of the fold.
    expect(links()).toContain("/acme/my-tasks");
    fireEvent.click(screen.getByRole("button", { name: "Teams" }));
    expect(links()).toContain("/acme/team/ENG");
    expect(readCookie("knw_teams_acme")).toBeNull();
  });

  it("keeps the open team listed while the list is folded", () => {
    document.cookie = "knw_teams_acme=1; path=/";
    mocks.pathname = "/acme/team/ENG";
    mount();
    expect(links()).toContain("/acme/team/ENG");
  });

  it("starts folded when the viewer folded it before", () => {
    document.cookie = "knw_teams_acme=1; path=/";
    mount();
    expect(links()).not.toContain("/acme/team/ENG");
  });

  it("hides the calendar when that module is off, and the wiki and tasks without access", () => {
    mount({
      boot: {
        modules: modules([
          ["tasks", "none"],
          ["docs", "none"],
          ["items", "write"],
        ]),
      } as Partial<Bootstrap>,
    });
    for (const href of [
      "/acme/my-tasks",
      "/acme/projects",
      "/acme/team/ENG",
      "/acme/calendar",
      "/acme/docs",
    ]) {
      expect(links()).not.toContain(href);
    }
  });

  it("shows only the sections of the module the page belongs to", () => {
    mocks.pathname = "/acme/items";
    mount();
    expect(links()).toContain("/acme/items");
    expect(links()).toContain("/acme/suppliers");
    // Other modules' pages are one switch away, not in the way.
    expect(links()).not.toContain("/acme/stock");
    expect(links()).not.toContain("/acme/settings/members");
  });

  it("follows the page into another module", () => {
    mocks.pathname = "/acme/suppliers/s1";
    mount().unmount();
    expect(links).toThrow(); // nothing left mounted
    mocks.pathname = "/acme/time";
    mount();
    expect(links()).toContain("/acme/time");
    expect(links()).not.toContain("/acme/suppliers");
  });

  it("names the current module under the workspace name", () => {
    mocks.pathname = "/acme/items";
    mount();
    const header = screen.getByRole("button", { name: /Acme, showing Items & suppliers/ });
    expect(within(header).getByText("Items & suppliers")).toBeTruthy();
  });

  it("lists the modules the viewer can use, filters them, and opens the chosen one", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Switch module/ }));
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("Items & suppliers")).toBeTruthy();
    // Tasks, calendar and the wiki are always in the sidebar, so they are not modules to pick.
    expect(within(list).queryByText("Docs")).toBeNull();
    expect(within(list).queryByText("Tasks")).toBeNull();
    expect(within(list).getByText("Time")).toBeTruthy();
    // No access to food safety.
    expect(within(list).queryByText("Food safety")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Find a module…"), { target: { value: "suppl" } });
    expect(within(screen.getByRole("listbox")).queryByText("Time")).toBeNull();
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Items & suppliers"));
    expect(mocks.push).toHaveBeenCalledWith("/acme/items");
  });

  it("stars a module as the default without opening it", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Switch module/ }));
    fireEvent.click(screen.getByRole("button", { name: "Set Items & suppliers as your default module" }));
    expect(readCookie("knw_home_acme")).toBe("items");
    expect(mocks.push).not.toHaveBeenCalled();
    // Starred; a second click clears it.
    fireEvent.click(screen.getByRole("button", { name: /Items & suppliers is your default module/ }));
    expect(readCookie("knw_home_acme")).toBeNull();
  });

  it("uses the default module on pages that belong to none", () => {
    mocks.pathname = "/acme/inbox";
    document.cookie = "knw_home_acme=items; path=/";
    mount();
    expect(links()).toContain("/acme/suppliers");
  });

  it("lists only the last five docs opened, newest first, whichever module is showing", () => {
    for (const id of ["d1", "d2", "d3", "d4", "d5", "d6", "d7"]) {
      mocks.pathname = `/acme/docs/${id}`;
      mount().unmount();
    }
    mocks.pathname = "/acme/items";
    mount();
    const recent = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"))
      .filter((h) => h?.startsWith("/acme/docs/"));
    expect(recent).toEqual([
      "/acme/docs/d7",
      "/acme/docs/d6",
      "/acme/docs/d5",
      "/acme/docs/d4",
      "/acme/docs/d3",
    ]);
  });

  it("leaves out recent docs the viewer can no longer read or that no longer exist", () => {
    window.localStorage.setItem("knw:recent-docs:u1:acme", JSON.stringify(["gone", "d2"]));
    mount();
    const recent = links().filter((h) => h?.startsWith("/acme/docs/"));
    expect(recent).toEqual(["/acme/docs/d2"]);
  });

  it("hides recent docs without access to docs", () => {
    window.localStorage.setItem("knw:recent-docs:u1:acme", JSON.stringify(["d2"]));
    mount({
      boot: {
        modules: modules([
          ["tasks", "write"],
          ["docs", "none"],
        ]),
      } as Partial<Bootstrap>,
    });
    expect(links().some((h) => h?.startsWith("/acme/docs/"))).toBe(false);
  });
});
