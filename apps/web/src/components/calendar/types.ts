import type { CalendarConnection, Meeting, PersonalEvent } from "@/lib/api";

export type { CalendarConnection, Meeting, PersonalEvent };

export interface Member {
  id: string;
  name: string;
  email: string;
}

/** A meeting or a private calendar event, normalised for the grid. */
export interface CalendarItem {
  key: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  cancelled: boolean;
  tone: "meeting" | "google" | "microsoft";
  meeting?: Meeting;
  event?: PersonalEvent;
}

export const providerName = { google: "Google Calendar", microsoft: "Outlook" } as const;
export const videoName = { google: "Google Meet", microsoft: "Microsoft Teams" } as const;
