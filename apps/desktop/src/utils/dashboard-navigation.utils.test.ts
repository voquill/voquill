import { describe, expect, it } from "vitest";
import {
  DASHBOARD_SECTION_PATHS,
  resolveDashboardSectionPath,
} from "./dashboard-navigation.utils";

describe("resolveDashboardSectionPath", () => {
  it("returns the dashboard root for home", () => {
    expect(resolveDashboardSectionPath("home")).toBe(
      DASHBOARD_SECTION_PATHS.home,
    );
  });

  it("returns the settings page for settings", () => {
    expect(resolveDashboardSectionPath("settings")).toBe(
      DASHBOARD_SECTION_PATHS.settings,
    );
  });

  it("returns undefined for unknown sections", () => {
    expect(resolveDashboardSectionPath("unknown")).toBeUndefined();
  });
});
