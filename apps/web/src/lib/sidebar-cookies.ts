/** Cookie names for the sidebar preferences. Plain module: the server reads them too. */
export const defaultAreaCookie = (slug: string) => `knw_home_${slug}`;
export const lastAreaCookie = (slug: string) => `knw_area_${slug}`;
export const teamsCollapsedCookie = (slug: string) => `knw_teams_${slug}`;
