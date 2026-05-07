export const DASHBOARD_SECTION_PATHS = {
  home: "/dashboard",
  history: "/dashboard/transcriptions",
  dictionary: "/dashboard/dictionary",
  styles: "/dashboard/styling",
  settings: "/dashboard/settings",
} as const;

export type DashboardSectionRoute = keyof typeof DASHBOARD_SECTION_PATHS;

export function resolveDashboardSectionPath(route: string) {
  return DASHBOARD_SECTION_PATHS[route as DashboardSectionRoute];
}
