"use client"

import * as React from "react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@knotworking/ui/components/command"
import { Popover, PopoverContent, PopoverTrigger } from "@knotworking/ui/components/popover"
import { cn } from "@knotworking/ui/lib/utils"

export interface PropertyOption {
  value: string
  label: string
  icon?: React.ReactNode
  /** Extra search terms (e.g. an email for a person). */
  keywords?: string[]
  /** Single key that picks this option while the menu is open (e.g. "1" for Urgent). */
  shortcut?: string
}

type Selection =
  | { multiple?: false; value: string | null; onValueChange: (value: string) => void }
  | { multiple: true; value: string[]; onValueChange: (value: string[]) => void }

type PropertyMenuProps = Selection & {
  options: PropertyOption[]
  /** The element that opens the menu (rendered with `asChild`). */
  children: React.ReactNode
  placeholder?: string
  emptyText?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSearchChange?: (search: string) => void
  align?: "start" | "center" | "end"
  className?: string
  /** Called as the menu closes and focus is about to return to the trigger; `preventDefault()` to focus elsewhere. */
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * Searchable property picker (status, priority, assignee, labels…): a popover
 * with a filterable list, a check on the current value, and optional single-key
 * shortcuts. Single-select closes on pick; multi-select stays open to toggle.
 */
function PropertyMenu({
  options,
  children,
  placeholder = "Search…",
  emptyText = "No results",
  open: openProp,
  onOpenChange,
  onSearchChange,
  align = "start",
  className,
  onCloseAutoFocus,
  ...selection
}: PropertyMenuProps) {
  const [openState, setOpenState] = React.useState(false)
  const open = openProp ?? openState
  const setOpen = (o: boolean) => {
    setOpenState(o)
    onOpenChange?.(o)
  }
  const [search, setSearch] = React.useState("")
  const changeSearch = (value: string) => {
    setSearch(value)
    onSearchChange?.(value)
  }

  const isSelected = (value: string) =>
    selection.multiple ? selection.value.includes(value) : selection.value === value

  const pick = (value: string) => {
    if (selection.multiple) {
      const current = selection.value
      selection.onValueChange(
        current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
      )
    } else {
      selection.onValueChange(value)
      setOpen(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Shortcuts only apply before the person starts typing a search.
    if (search || e.metaKey || e.ctrlKey || e.altKey) return
    const option = options.find((o) => o.shortcut && o.shortcut === e.key)
    if (option) {
      e.preventDefault()
      pick(option.value)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) changeSearch("")
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        className={cn("w-60 p-0", className)}
        onCloseAutoFocus={onCloseAutoFocus}
        // Keep drag-and-drop and global shortcuts from seeing events inside the menu.
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <Command onKeyDown={onKeyDown} filter={matches}>
          <CommandInput placeholder={placeholder} value={search} onValueChange={changeSearch} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  keywords={[o.label, ...(o.keywords ?? [])]}
                  data-checked={isSelected(o.value)}
                  onSelect={() => pick(o.value)}
                  className="[&>svg:last-child]:ml-0"
                >
                  {o.icon}
                  <span className="truncate">{o.label}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{o.shortcut}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Search labels and keywords only — option values are often opaque IDs. */
function matches(_value: string, search: string, keywords?: string[]) {
  const q = search.trim().toLowerCase()
  return !q || (keywords ?? []).some((k) => k.toLowerCase().includes(q)) ? 1 : 0
}

export { PropertyMenu }
