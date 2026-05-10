import { listen } from "@tauri-apps/api/event";
import { createTranscriptReconciler } from "@voquill/dictation-core";
import { getAppState } from "../store";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionFinalizeOptions,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { getEffectiveAuth } from "../utils/auth.utils";
import { getLogger } from "../utils/log.utils";
import { NEW_SERVER_URL } from "../utils/new-server.utils";
import {
  buildDictationContext,
  buildPostProcessingPrompt,
  buildSystemPostProcessingTonePrompt,
  collectDictionaryEntries,
  collectDictionaryTerms,
} from "../utils/prompt.utils";
import { getToneById, getToneConfig } from "../utils/tone.utils";
import {
  getMyUserName,
  loadMyEffectiveDictationLanguage,
} from "../utils/user.utils";

type TranscriptResult = {
  text: string;
  source: string;
  durationMs?: number;
  processed?: {
    text: string;
    durationMs?: number;
  };
  warnings: string[];
};

type FinalizeOptions = {
  prompt?: string;
  systemPrompt?: string;
};

type NewServerStreamingSession = {
  finalize: (options?: FinalizeOptions) => Promise<TranscriptResult>;
  cleanup: () => void;
};

type NewServerTranscriptState = {
  applyStreamEvent: (event: {
    text?: string | null;
    isFinal?: boolean;
  }) => {
    delta: string;
    authoritativeText: string;
  };
  applyAuthoritativeTranscript: (text?: string | null) => string;
  toRecoveredResult: (warning: string) => TranscriptResult;
};

export const getNewServerTranscriptDelta = (
  previousTranscript: string,
  nextTranscript: string,
): string => {
  const previous = previousTranscript.trim();
  const next = nextTranscript.trim();

  if (!next) {
    return "";
  }

  if (!previous) {
    return next;
  }

  if (next.startsWith(previous)) {
    return next.slice(previous.length).trim();
  }

  return next;
};

export const getRecoveredNewServerTranscriptResult = (
  committedTranscript: string,
  warning: string,
): TranscriptResult => {
  const recoveredTranscript = committedTranscript.trim();

  if (!recoveredTranscript) {
    return {
      text: "",
      source: "",
      warnings: [warning],
    };
  }

  return {
    text: recoveredTranscript,
    source: "New Server (Recovered Stream)",
    warnings: [warning],
  };
};

export const createNewServerTranscriptState = (): NewServerTranscriptState => {
  const reconciler = createTranscriptReconciler();

  const applyAuthoritativeTranscript = (text?: string | null): string => {
    return reconciler.applyFinal({ text: String(text ?? "") });
  };

  return {
    applyStreamEvent: ({ text, isFinal }) => {
      const nextText = String(text ?? "");
      const previousText = reconciler.getAuthoritativeTranscript();
      const authoritativeText = isFinal
        ? reconciler.applyFinal({ text: nextText })
        : reconciler.applyPartial({ text: nextText });

      return {
        delta: getNewServerTranscriptDelta(previousText, authoritativeText),
        authoritativeText,
      };
    },
    applyAuthoritativeTranscript,
    toRecoveredResult: (warning) =>
      getRecoveredNewServerTranscriptResult(
        reconciler.getAuthoritativeTranscript(),
        warning,
      ),
  };
};

const startNewServerStreaming = async (
  sampleRate: number,
  glossary: string[],
  language?: string,
  interimCallback?: (segment: string) => void,
): Promise<NewServerStreamingSession> => {
  console.log("[NewServer WebSocket] Starting with sample rate:", sampleRate);

  let ws: WebSocket | null = null;
  let isFinalized = false;
  let isReady = false;
  let sentChunkCount = 0;
  let droppedChunkCount = 0;
  const transcriptState = createNewServerTranscriptState();
  const bufferedChunks: Float32Array[] = [];

  const unlisten = await listen<{ samples: number[] }>(
    "audio_chunk",
    (event) => {
      if (isFinalized) {
        return;
      }

      const samples = new Float32Array(event.payload.samples);

      if (!isReady) {
        bufferedChunks.push(samples);
        if (bufferedChunks.length <= 3 || bufferedChunks.length % 10 === 0) {
          console.log(
            `[NewServer WebSocket] Buffered chunk #${bufferedChunks.length} (${samples.length} samples)`,
          );
        }
        return;
      }

      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(samples.buffer as ArrayBuffer);
          sentChunkCount++;
          if (sentChunkCount <= 3 || sentChunkCount % 10 === 0) {
            console.log(
              `[NewServer WebSocket] Sent chunk #${sentChunkCount} (${samples.length} samples)`,
            );
          }
        } catch (error) {
          console.error(
            "[NewServer WebSocket] Error sending audio chunk:",
            error,
          );
        }
      } else {
        droppedChunkCount++;
        if (droppedChunkCount === 1) {
          getLogger().warning(
            `[NewServer WebSocket] Connection lost, dropping audio chunks (wsState=${ws?.readyState}, sent=${sentChunkCount})`,
          );
        }
      }
    },
  );

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (finalizeTimeout) {
        clearTimeout(finalizeTimeout);
        finalizeTimeout = null;
      }
      unlisten();
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
        ws = null;
      }
    };

    let finalizeResolver: ((result: TranscriptResult) => void) | null = null;
    let finalizeRejecter: ((error: Error) => void) | null = null;
    let finalizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const settleFinalize = (result: TranscriptResult) => {
      const resolver = finalizeResolver;
      finalizeResolver = null;
      finalizeRejecter = null;
      cleanup();
      resolver?.(result);
    };

    const finalize = (options?: FinalizeOptions): Promise<TranscriptResult> => {
      return new Promise((resolveFinalize, rejectFinalize) => {
        getLogger().info(
          `[NewServer WebSocket] Finalize called (wsState=${ws?.readyState}, sent=${sentChunkCount}, dropped=${droppedChunkCount})`,
        );

          if (isFinalized) {
            resolveFinalize(
              transcriptState.toRecoveredResult(
                "Streaming session was already finalized",
              ),
            );
            return;
          }

        isFinalized = true;
        finalizeResolver = resolveFinalize;
        finalizeRejecter = rejectFinalize;

        if (ws && ws.readyState === WebSocket.OPEN) {
          const finalizeMsg: Record<string, unknown> = { type: "finalize" };
          if (options?.prompt) {
            finalizeMsg.prompt = options.prompt;
          }
          if (options?.systemPrompt) {
            finalizeMsg.systemPrompt = options.systemPrompt;
          }
          getLogger().info(
            `[NewServer WebSocket] Sending finalize message (hasPrompt=${!!options?.prompt})...`,
          );
          ws.send(JSON.stringify(finalizeMsg));

          const timeoutMs = options?.prompt ? 30000 : 15000;
          finalizeTimeout = setTimeout(() => {
            const warning = `Server did not respond within ${timeoutMs / 1000} seconds; using recovered stream transcript if available`;
            getLogger().warning(
              `[NewServer WebSocket] Finalize timeout (${timeoutMs / 1000}s)`,
            );
            if (finalizeRejecter) {
              settleFinalize(
                transcriptState.toRecoveredResult(warning),
              );
            }
          }, timeoutMs);
        } else {
          const warning =
            "Streaming connection closed before final transcript was received; using recovered stream transcript if available";
          getLogger().warning(
            `[NewServer WebSocket] Socket not open at finalize, using recovered transcript if available (wsState=${ws?.readyState})`,
          );
          settleFinalize(
            transcriptState.toRecoveredResult(warning),
          );
        }
      });
    };

    const wsUrl = NEW_SERVER_URL.replace(/^http/, "ws") + "/v1/dictation";
    console.log("[NewServer WebSocket] Connecting to:", wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      console.log("[NewServer WebSocket] Connected, authenticating...");

      try {
        const auth = getEffectiveAuth();
        const user = auth.currentUser;
        if (!user) {
          reject(new Error("Not authenticated"));
          cleanup();
          return;
        }
        const idToken = await user.getIdToken();
        ws!.send(JSON.stringify({ type: "auth", idToken }));
      } catch (err) {
        reject(err);
        cleanup();
      }
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log("[NewServer WebSocket] Received:", msg.type);

        if (msg.type === "error") {
          console.error(
            "[NewServer WebSocket] Server error:",
            msg.code,
            msg.message,
          );
          const error = new Error(`${msg.code}: ${msg.message}`);
          if (finalizeRejecter) {
            settleFinalize(
              transcriptState.toRecoveredResult(
                `New server returned an error during finalize: ${error.message}`,
              ),
            );
          } else {
            reject(error);
            cleanup();
          }
          return;
        }

        if (msg.type === "authenticated") {
          console.log(
            "[NewServer WebSocket] Authenticated, words remaining:",
            msg.wordsRemaining,
          );
          ws!.send(
            JSON.stringify({
              type: "config",
              sampleRate,
              glossary,
              language,
            }),
          );
          return;
        }

        if (msg.type === "ready") {
          console.log(
            `[NewServer WebSocket] Ready, flushing ${bufferedChunks.length} buffered chunks`,
          );
          isReady = true;

          for (const samples of bufferedChunks) {
            if (ws && ws.readyState === WebSocket.OPEN && !isFinalized) {
              try {
                ws.send(samples.buffer as ArrayBuffer);
                sentChunkCount++;
              } catch (error) {
                console.error(
                  "[NewServer WebSocket] Error sending buffered chunk:",
                  error,
                );
              }
            }
          }
          bufferedChunks.length = 0;
          console.log(
            `[NewServer WebSocket] Flushed ${sentChunkCount} chunks, session ready`,
          );

          resolve({ finalize, cleanup });
          return;
        }

        if (msg.type === "partial_transcript") {
          if (msg.text) {
            const { delta } = transcriptState.applyStreamEvent({
              text: msg.text,
              isFinal: msg.is_final,
            });

            if (msg.is_final && delta) {
              interimCallback?.(delta);
            }
          }
          return;
        }

        if (msg.type === "transcript") {
          console.log(
            "[NewServer WebSocket] Transcript received, length:",
            msg.text?.length ?? 0,
            "source:",
            msg.source,
            "hasProcessed:",
            !!msg.processed,
          );
          if (finalizeTimeout) {
            clearTimeout(finalizeTimeout);
            finalizeTimeout = null;
          }
          if (finalizeResolver) {
            const authoritativeText = transcriptState.applyAuthoritativeTranscript(
              msg.text || "",
            );
            settleFinalize({
              text: authoritativeText,
              source: msg.source || "",
              durationMs: msg.durationMs,
              processed: msg.processed
                ? {
                    text: msg.processed.text,
                    durationMs: msg.processed.durationMs,
                  }
                : undefined,
              warnings: [],
            });
          }
          return;
        }
      } catch (err) {
        console.error("[NewServer WebSocket] Error parsing message:", err);
      }
    };

    ws.onerror = (error) => {
      getLogger().error("[NewServer WebSocket] WebSocket error:", error);
      if (!isReady) {
        cleanup();
        reject(new Error("WebSocket connection failed"));
      }
    };

    ws.onclose = (event) => {
      getLogger().warning(
        `[NewServer WebSocket] Connection closed (code=${event.code}, reason=${event.reason || "none"}, sent=${sentChunkCount}, isReady=${isReady}, isFinalized=${isFinalized})`,
      );
      if (finalizeRejecter) {
        settleFinalize(
          transcriptState.toRecoveredResult(
            "Streaming connection closed unexpectedly; using recovered stream transcript if available",
          ),
        );
      } else if (!isReady) {
        reject(new Error("Connection closed before ready"));
      }
    };
  });
};

export class NewServerTranscriptionSession implements TranscriptionSession {
  private session: NewServerStreamingSession | null = null;
  private startError: Error | null = null;
  private interimCallback: ((segment: string) => void) | null = null;

  async onRecordingStart(sampleRate: number): Promise<void> {
    try {
      getLogger().info("[NewServer] Starting streaming session...");

      const state = getAppState();
      const entries = collectDictionaryEntries(state);
      const language = await loadMyEffectiveDictationLanguage(state);
      this.session = await startNewServerStreaming(
        sampleRate,
        entries.sources,
        language,
        this.interimCallback ?? undefined,
      );

      getLogger().info("[NewServer] Streaming session started successfully");
    } catch (error) {
      getLogger().error("[NewServer] Failed to start streaming:", error);
      this.startError =
        error instanceof Error ? error : new Error(String(error));
      throw new Error(
        "Unable to connect to the server. Please check your internet connection or try signing in again.",
      );
    }
  }

  async finalize(
    _audio: StopRecordingResponse,
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<TranscriptionSessionResult> {
    if (!this.session) {
      const reason = this.startError
        ? `New server connection failed: ${this.startError.message}`
        : "New server streaming session was not established";
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: "Cloud • New Server (Streaming)",
          transcriptionMode: "cloud",
        },
        warnings: [reason],
      };
    }

    try {
      const finalizeOptions = await this.buildFinalizeOptions(options);
      getLogger().info(
        `[NewServer] Finalizing streaming session (hasPrompt=${!!finalizeOptions?.prompt})...`,
      );
      const result = await this.session.finalize(finalizeOptions);
      getLogger().info("[NewServer] Transcript received:", {
        length: result.text?.length ?? 0,
        source: result.source,
        durationMs: result.durationMs,
        hasProcessed: !!result.processed,
      });

      return {
        rawTranscript: result.text || null,
        processedTranscript: result.processed?.text || null,
        authoritativeTranscript: result.text || null,
        isAuthoritative: true,
        isFinalized: true,
        dictationIntent: {
          kind: "dictation",
          format: result.processed ? "clean" : "verbatim",
        },
        metadata: {
          inferenceDevice: `Cloud • ${result.source || "New Server"}`,
          transcriptionMode: "cloud",
          transcriptionDurationMs: result.durationMs ?? null,
        },
        postProcessMetadata: result.processed
          ? {
              postProcessMode: "cloud",
              postProcessDevice: "Cloud • Dictation Server",
              postprocessDurationMs: result.processed.durationMs ?? null,
            }
          : undefined,
        warnings: result.warnings,
      };
    } catch (error) {
      getLogger().error("[NewServer] Failed to finalize session:", error);
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: "Cloud • New Server (Streaming)",
          transcriptionMode: "cloud",
        },
        warnings: [
          `New server finalization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        ],
      };
    }
  }

  private async buildFinalizeOptions(
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<FinalizeOptions | undefined> {
    const state = getAppState();
    if (state.activeRecordingMode !== "dictate") {
      return undefined;
    }

    const toneId = options?.toneId ?? null;
    const tone = getToneById(state, toneId);
    if (tone?.shouldDisablePostProcessing) {
      return undefined;
    }

    const toneConfig = getToneConfig(state, toneId);
    const dictationLanguage = await loadMyEffectiveDictationLanguage(state);
    const context = buildDictationContext({
      dictationLanguage,
      intent: {
        kind: "dictation",
        format: tone?.shouldDisablePostProcessing ? "verbatim" : "clean",
      },
      terms: collectDictionaryTerms(state),
      currentApp: options?.currentApp ?? null,
      currentEditor: options?.currentEditor ?? null,
      selectedText: options?.selectedText ?? null,
      screenContext: options?.screenContext ?? null,
    });
    const promptInput = {
      transcript: "{{transcript}}",
      userName: getMyUserName(state),
      dictationLanguage,
      tone: toneConfig,
      context,
    };

    return {
      prompt: buildPostProcessingPrompt(promptInput),
      systemPrompt: buildSystemPostProcessingTonePrompt(promptInput),
    };
  }

  cleanup(): void {
    if (this.session) {
      this.session.cleanup();
      this.session = null;
    }
  }

  supportsStreaming(): boolean {
    return true;
  }

  setInterimResultCallback(callback: (segment: string) => void): void {
    this.interimCallback = callback;
  }
}
