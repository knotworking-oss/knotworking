"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Kbd } from "@knotworking/ui/components/kbd";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { isHelpKey, isOverlayOpen, isTypingTarget, shortcutGroups } from "@/lib/keyboard";

const Ctx = createContext<{ show: () => void }>({ show: () => {} });
export const useShortcutsHelp = () => useContext(Ctx);

/** `?` (or the command menu) lists every keyboard shortcut. */
export function ShortcutsHelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isHelpKey(e) || e.defaultPrevented || isTypingTarget(e.target) || isOverlayOpen()) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Ctx.Provider value={{ show: () => setOpen(true) }}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Single-key shortcuts work when you are not typing in a field.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 sm:grid-cols-2">
            {shortcutGroups.map((group) => (
              <section key={group.title} aria-label={group.title} className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">{group.title}</h3>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {group.shortcuts.map((s) => (
                    <li key={s.keys.join("+") + s.description} className="flex items-start gap-3">
                      <span className="flex w-24 shrink-0 flex-wrap gap-1">
                        {s.keys.map((k, i) => (
                          <Kbd key={i}>{k}</Kbd>
                        ))}
                      </span>
                      <span>{s.description}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}
