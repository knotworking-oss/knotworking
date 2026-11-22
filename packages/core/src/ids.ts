import { uuidv7 } from "uuidv7";

/**
 * All entity IDs are UUIDv7: globally unique, so any client (web, desktop,
 * mobile — even offline) can create records without a server round-trip, and
 * time-ordered, so they index well in Postgres and SQLite.
 */
export const newId = (): string => uuidv7();
