/**
 * How many weeks the demand plan grid shows at a time. Kept out of the client grid module: the
 * server page reads it, and a "use client" module's exports are only references on the server.
 */
export const GRID_RANGES = [4, 8, 12, 26] as const;
export type GridRange = (typeof GRID_RANGES)[number];
