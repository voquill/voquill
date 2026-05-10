import { describe, expect, it } from "vitest";
import { createTranscriptReconciler } from "../src/index";

describe("createTranscriptReconciler", () => {
  it("replaces earlier streamed text with authoritative final text", () => {
    const reconciler = createTranscriptReconciler();

    reconciler.applyPartial({ text: "hello wor" });
    reconciler.applyFinal({ text: "hello world" });

    expect(reconciler.getAuthoritativeTranscript()).toBe("hello world");
  });

  it("does not regress to a later partial after a final is applied", () => {
    const reconciler = createTranscriptReconciler();

    reconciler.applyPartial({ text: "hello wor" });
    reconciler.applyFinal({ text: "hello world" });
    reconciler.applyPartial({ text: "hello world maybe" });

    expect(reconciler.getAuthoritativeTranscript()).toBe("hello world");
  });
});
