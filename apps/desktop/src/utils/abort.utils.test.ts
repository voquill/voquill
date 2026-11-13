import { describe, expect, it, vi } from "vitest";
import { runWithAttemptTimeout } from "./abort.utils";

describe("runWithAttemptTimeout", () => {
  it("aborts a hung task with a timeout error", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const run = runWithAttemptTimeout(
      (signal) =>
        new Promise<string>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      5_000,
    );
    const outcome = expect(run).rejects.toThrow("Timed out after 5s");
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(aborted).toBe(true);
    vi.useRealTimers();
  });

  it("never times out without a limit", async () => {
    await expect(runWithAttemptTimeout(async () => "done", null)).resolves.toBe(
      "done",
    );
  });
});
