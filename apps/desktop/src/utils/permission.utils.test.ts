import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();

  return {
    ...actual,
    invoke: invokeMock,
  };
});

describe("screen recording permission wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("checks screen recording permission via the native tauri command", async () => {
    const expected = {
      kind: "screen-recording",
      state: "authorized",
      promptShown: false,
    } as const;

    invokeMock.mockResolvedValue(expected);

    const { checkScreenRecordingPermission } = await import("./permission.utils");

    await expect(checkScreenRecordingPermission()).resolves.toEqual(expected);
    expect(invokeMock).toHaveBeenCalledWith("check_screen_recording_permission");
  });

  it("requests screen recording permission via the native tauri command", async () => {
    const expected = {
      kind: "screen-recording",
      state: "not-determined",
      promptShown: true,
    } as const;

    invokeMock.mockResolvedValue(expected);

    const { requestScreenRecordingPermission } = await import("./permission.utils");

    await expect(requestScreenRecordingPermission()).resolves.toEqual(expected);
    expect(invokeMock).toHaveBeenCalledWith(
      "request_screen_recording_permission",
    );
  });
});
