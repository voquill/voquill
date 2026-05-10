import { describe, expect, it } from "vitest";
import {
  createProviderCapabilityRegistry,
  selectBestAccuracyPath,
} from "../src/index";

describe("provider capability selection", () => {
  it("indexes provider capabilities by provider and model", () => {
    const registry = createProviderCapabilityRegistry([
      {
        provider: "azure",
        model: "whisper",
        supportsStreaming: true,
        supportsPrompt: false,
      },
      {
        provider: "deepgram",
        model: "nova-3",
        supportsStreaming: true,
        supportsPrompt: true,
      },
    ]);

    expect(registry.get("deepgram", "nova-3")).toMatchObject({
      provider: "deepgram",
      supportsPrompt: true,
    });
    expect(registry.get("azure", "whisper")?.supportsPrompt).toBe(false);
  });

  it("matches provider lookup case-insensitively when no model is supplied", () => {
    const registry = createProviderCapabilityRegistry([
      {
        provider: "deepgram",
        model: "nova-3",
        supportsStreaming: true,
        supportsPrompt: true,
      },
    ]);

    expect(registry.get("DeepGram")).toMatchObject({
      provider: "deepgram",
      model: "nova-3",
    });
  });

  it("rejects providers that cannot satisfy required prompt and streaming support", () => {
    const result = selectBestAccuracyPath({
      required: { streaming: true, prompt: true },
      candidates: [
        {
          provider: "azure",
          model: "whisper",
          supportsStreaming: true,
          supportsPrompt: false,
          priority: 1,
        },
        {
          provider: "deepgram",
          model: "nova-3",
          supportsStreaming: true,
          supportsPrompt: true,
          priority: 2,
        },
      ],
    });

    expect(result).toMatchObject({
      provider: "deepgram",
      model: "nova-3",
    });
  });
});
