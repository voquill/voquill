import { describe, expect, it, vi } from "vitest";
import type { ApiTranscriptionPrefs } from "../utils/user.utils";
import { getTranscribeAudioRepo } from ".";
import {
  GroqTranscribeAudioRepo,
  UnsupportedTranscribeAudioRepo,
} from "./transcribe-audio.repo";

const apiPrefs = (
  provider: ApiTranscriptionPrefs["provider"],
): ApiTranscriptionPrefs => ({
  mode: "api",
  provider,
  apiKeyId: "key",
  apiKeyValue: "",
  transcriptionModel: null,
  warnings: [],
});

describe("getTranscribeAudioRepo", () => {
  it("refuses a provider that cannot transcribe instead of sending the audio elsewhere", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { repo, warnings } = getTranscribeAudioRepo(apiPrefs("ollama"));

    expect(repo).toBeInstanceOf(UnsupportedTranscribeAudioRepo);
    expect(warnings).toContain(
      "ollama does not support transcription; choose a transcription provider.",
    );
    await expect(
      repo.transcribeAudio({
        samples: new Float32Array(16_000).fill(0.1),
        sampleRate: 16_000,
      }),
    ).rejects.toThrow("ollama can't transcribe audio");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it.each([
    "claude",
    "deepseek",
    "openrouter",
    "cerebras",
    "cheaperinference",
  ] as const)("refuses %s too", (provider) => {
    expect(getTranscribeAudioRepo(apiPrefs(provider)).repo).toBeInstanceOf(
      UnsupportedTranscribeAudioRepo,
    );
  });

  it("still uses Groq when Groq is chosen", () => {
    expect(getTranscribeAudioRepo(apiPrefs("groq")).repo).toBeInstanceOf(
      GroqTranscribeAudioRepo,
    );
  });
});
