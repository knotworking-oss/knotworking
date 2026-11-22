"use client";
import { weekdayNames } from "@knotworking/core";

/** Seven checkboxes over a weekday mask (bit 0 = Monday … bit 6 = Sunday). */
export function WeekdayPicker({
  value,
  onChange,
  id,
}: {
  value: number;
  onChange: (v: number) => void;
  id: string;
}) {
  return (
    <div id={id} role="group" className="flex flex-wrap gap-3">
      {weekdayNames.map((d, i) => (
        <label key={d} className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={(value & (1 << i)) !== 0}
            onChange={(e) => onChange(e.target.checked ? value | (1 << i) : value & ~(1 << i))}
          />
          {d}
        </label>
      ))}
    </div>
  );
}
