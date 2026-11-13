import { afterEach, describe, expect, it, vi } from "vitest";

type Handler = ((sender: unknown, event: never) => void) | undefined;

const ResultReason = { RecognizedSpeech: 3, NoMatch: 0 };
const CancellationReason = { Error: 1, EndOfStream: 2 };

/** Emits the given phrases one per pause, like continuous recognition does. */
const mockSpeechSdk = (script: (recognizer: FakeRecognizer) => void) => {
  const recognizers: FakeRecognizer[] = [];
  class FakeRecognizer {
    recognized: Handler;
    canceled: Handler;
    sessionStopped: Handler;
    recognizeOnceAsync = vi.fn();
    stopContinuousRecognitionAsync = vi.fn((done: () => void) => done());
    close = vi.fn();
    constructor() {
      recognizers.push(this);
    }
    startContinuousRecognitionAsync(onStarted: () => void) {
      onStarted();
      script(this);
    }
    emit(handler: "recognized" | "canceled" | "sessionStopped", event: unknown) {
      (this[handler] as ((s: unknown, e: unknown) => void) | undefined)?.(
        this,
        event,
      );
    }
  }
  const pushStream = { write: vi.fn(), close: vi.fn() };
  vi.doMock("microsoft-cognitiveservices-speech-sdk", () => ({
    SpeechConfig: { fromSubscription: () => ({}) },
    AudioStreamFormat: { getWaveFormatPCM: () => ({}) },
    AudioInputStream: { createPushStream: () => pushStream },
    AudioConfig: { fromStreamInput: () => ({}) },
    PhraseListGrammar: { fromRecognizer: () => ({ addPhrase: vi.fn() }) },
    SpeechRecognizer: FakeRecognizer,
    ResultReason,
    CancellationReason,
  }));
  return { recognizers, pushStream };
};

const phrase = (text: string) => ({
  result: { reason: ResultReason.RecognizedSpeech, text },
});

describe("azureTranscribeRecording", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("microsoft-cognitiveservices-speech-sdk");
  });

  it("returns every phrase of a multi-sentence recording, not just the first", async () => {
    const { recognizers, pushStream } = mockSpeechSdk((recognizer) => {
      recognizer.emit("recognized", phrase("First sentence."));
      recognizer.emit("recognized", {
        result: { reason: ResultReason.NoMatch, text: "" },
      });
      recognizer.emit("recognized", phrase("Second sentence after a pause."));
      recognizer.emit("canceled", { reason: CancellationReason.EndOfStream });
      recognizer.emit("recognized", phrase("Third."));
      recognizer.emit("sessionStopped", {});
    });
    const { azureTranscribeRecording } = await import("../src/azure.utils");

    const result = await azureTranscribeRecording({
      subscriptionKey: "key",
      region: "eastus",
      samples: new Float32Array([0.5, -0.5, 0]),
      sampleRate: 16_000,
      language: "en",
    });

    expect(result.text).toBe(
      "First sentence. Second sentence after a pause. Third.",
    );
    expect(recognizers[0].recognizeOnceAsync).not.toHaveBeenCalled();
    const written = new Int16Array(pushStream.write.mock.calls[0][0]);
    expect(Array.from(written)).toEqual([16383, -16384, 0]);
    expect(pushStream.close).toHaveBeenCalled();
    expect(recognizers[0].close).toHaveBeenCalled();
  });

  it("rejects when recognition is canceled by an error", async () => {
    mockSpeechSdk((recognizer) => {
      recognizer.emit("recognized", phrase("Partial."));
      recognizer.emit("canceled", {
        reason: CancellationReason.Error,
        errorDetails: "Connection was closed",
      });
    });
    const { azureTranscribeRecording } = await import("../src/azure.utils");

    await expect(
      azureTranscribeRecording({
        subscriptionKey: "key",
        region: "eastus",
        samples: new Float32Array([0.1]),
        sampleRate: 16_000,
      }),
    ).rejects.toThrow("Azure recognition failed: Connection was closed");
  });
});

describe("createAzureStreamingSession finalize", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("microsoft-cognitiveservices-speech-sdk");
  });

  const start = async (onStreamClosed: (recognizer: never) => void) => {
    const recognizers: { emit: (h: string, e: unknown) => void }[] = [];
    const sdk = mockSpeechSdk(() => {});
    sdk.pushStream.close.mockImplementation(() =>
      onStreamClosed(recognizers[0] as never),
    );
    const { createAzureStreamingSession } = await import("../src/azure.utils");
    const session = await createAzureStreamingSession({
      subscriptionKey: "key",
      region: "eastus",
      sampleRate: 16_000,
      language: "en",
    });
    recognizers.push(sdk.recognizers[0] as never);
    return { session, recognizer: sdk.recognizers[0] };
  };

  it("waits for the service to reach the end of the audio before stopping", async () => {
    const { session, recognizer } = await start((r: never) => {
      const rec = r as unknown as {
        emit: (h: string, e: unknown) => void;
        stopContinuousRecognitionAsync: ReturnType<typeof vi.fn>;
      };
      expect(rec.stopContinuousRecognitionAsync).not.toHaveBeenCalled();
      rec.emit("recognized", phrase("Last phrase."));
      rec.emit("sessionStopped", {});
    });
    recognizer.emit("recognized", phrase("First phrase."));

    await expect(session.finalize()).resolves.toBe(
      "First phrase. Last phrase.",
    );
    expect(session.getError()).toBeNull();
  });

  it("reports a timeout through getError instead of passing partial text off as complete", async () => {
    vi.useFakeTimers();
    const { session, recognizer } = await start(() => {});
    recognizer.emit("recognized", phrase("First phrase."));

    const result = session.finalize();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toBe("First phrase.");
    expect(session.getError()).toBe(
      "Azure did not finish recognizing within 5s",
    );
  });
});
