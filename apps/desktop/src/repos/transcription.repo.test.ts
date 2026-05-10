import type { Transcription } from "@voquill/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppState, INITIAL_APP_STATE } from "../state/app.state";
import { LocalTranscriptionRepo } from "./transcription.repo";

const { storeState, invokeMock } = vi.hoisted(() => ({
  storeState: {
    appState: undefined as AppState | undefined,
  },
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();

  return {
    ...actual,
    invoke: invokeMock,
  };
});

vi.mock("../store", () => ({
  getAppState: () => storeState.appState,
}));

describe("LocalTranscriptionRepo", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    storeState.appState = structuredClone(INITIAL_APP_STATE);
  });

  it("round-trips authoritative contract fields through desktop storage payloads", async () => {
    const repo = new LocalTranscriptionRepo();
    const transcription: Transcription = {
      id: "tx-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      createdByUserId: "local-user-id",
      transcript: "Hello world",
      isDeleted: false,
      rawTranscript: "hello world",
      authoritativeTranscript: "hello world",
      isAuthoritative: true,
      isFinalized: true,
      dictationIntent: {
        kind: "dictation",
        format: "clean",
      },
    };

    invokeMock.mockResolvedValue({
      id: "tx-1",
      transcript: "Hello world",
      timestamp: Date.parse("2026-04-22T00:00:00.000Z"),
      rawTranscript: "hello world",
      authoritativeTranscript: "hello world",
      isAuthoritative: true,
      isFinalized: true,
      dictationIntent: {
        kind: "dictation",
        format: "clean",
      },
    });

    const stored = await repo.createTranscription(transcription);

    expect(invokeMock).toHaveBeenCalledWith("transcription_create", {
      transcription: expect.objectContaining({
        authoritativeTranscript: "hello world",
        isAuthoritative: true,
        isFinalized: true,
        dictationIntent: {
          kind: "dictation",
          format: "clean",
        },
      }),
    });
    expect(stored).toMatchObject({
      authoritativeTranscript: "hello world",
      isAuthoritative: true,
      isFinalized: true,
      dictationIntent: {
        kind: "dictation",
        format: "clean",
      },
    });
  });
});
