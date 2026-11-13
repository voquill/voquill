import type { Transcription } from "@voquill/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { FAILED_TRANSCRIPT_PLACEHOLDER } from "./transcribe.actions";
import {
  findLatestSuccessfulTranscript,
  retranscribeTranscription,
} from "./transcriptions.actions";

const mocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  postProcessTranscript: vi.fn(),
  addWordsToCurrentUser: vi.fn(),
  updateTranscription: vi.fn(),
  history: [] as Transcription[],
}));

vi.mock(import("./transcribe.actions"), async (importOriginal) => ({
  ...(await importOriginal()),
  transcribeAudio: mocks.transcribeAudio,
  postProcessTranscript: mocks.postProcessTranscript,
}));
vi.mock("./user.actions", () => ({
  addWordsToCurrentUser: mocks.addWordsToCurrentUser,
}));
vi.mock(import("../repos"), async (importOriginal) => ({
  ...(await importOriginal()),
  getTranscriptionRepo: () =>
    ({
      loadTranscriptionAudio: async () => ({
        samples: [0.1, 0.2],
        sampleRate: 16_000,
      }),
      updateTranscription: mocks.updateTranscription,
      listTranscriptions: async ({
        limit,
        offset,
      }: {
        limit: number;
        offset: number;
      }) => mocks.history.slice(offset, offset + limit),
    }) as never,
}));

const transcription = (transcript: string): Transcription => ({
  id: "t1",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdByUserId: "u",
  transcript,
  isDeleted: false,
});

describe("retranscribeTranscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addWordsToCurrentUser.mockResolvedValue(undefined);
    mocks.transcribeAudio.mockResolvedValue({
      rawTranscript: "three little words",
      warnings: [],
      metadata: {},
    });
    mocks.postProcessTranscript.mockResolvedValue({
      transcript: "Three little words.",
      warnings: [],
      metadata: {},
    });
    mocks.updateTranscription.mockImplementation(
      async (updated: Transcription) => updated,
    );
  });

  it("counts the words of a failed dictation when its retry succeeds", async () => {
    setAppState({
      ...INITIAL_APP_STATE,
      transcriptionById: { t1: transcription(FAILED_TRANSCRIPT_PLACEHOLDER) },
    });

    await retranscribeTranscription({ transcriptionId: "t1" });

    expect(getAppState().transcriptionById.t1.transcript).toBe(
      "Three little words.",
    );
    expect(mocks.addWordsToCurrentUser).toHaveBeenCalledTimes(1);
    expect(mocks.addWordsToCurrentUser).toHaveBeenCalledWith(3);
  });

  it("does not count words again when retranscribing a successful dictation", async () => {
    setAppState({
      ...INITIAL_APP_STATE,
      transcriptionById: { t1: transcription("Already counted.") },
    });

    await retranscribeTranscription({ transcriptionId: "t1" });

    expect(mocks.addWordsToCurrentUser).not.toHaveBeenCalled();
  });

  it("counts a failed dictation's words once when retried twice at the same time", async () => {
    setAppState({
      ...INITIAL_APP_STATE,
      transcriptionById: { t1: transcription(FAILED_TRANSCRIPT_PLACEHOLDER) },
    });

    await Promise.all([
      retranscribeTranscription({ transcriptionId: "t1" }),
      retranscribeTranscription({ transcriptionId: "t1" }),
    ]);

    expect(mocks.transcribeAudio).toHaveBeenCalledTimes(1);
    expect(mocks.addWordsToCurrentUser).toHaveBeenCalledTimes(1);
  });
});

describe("findLatestSuccessfulTranscript", () => {
  it("skips failed dictations, across pages", async () => {
    mocks.history = [
      ...Array.from({ length: 25 }, () =>
        transcription(FAILED_TRANSCRIPT_PLACEHOLDER),
      ),
      transcription("the good one"),
      transcription("older"),
    ];
    expect(await findLatestSuccessfulTranscript()).toBe("the good one");
  });

  it("returns nothing when every entry failed", async () => {
    mocks.history = [transcription(FAILED_TRANSCRIPT_PLACEHOLDER)];
    expect(await findLatestSuccessfulTranscript()).toBeNull();
  });
});
