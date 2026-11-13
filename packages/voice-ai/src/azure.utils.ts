import * as sdk from "microsoft-cognitiveservices-speech-sdk";

export type AzureTranscriptionArgs = {
  subscriptionKey: string;
  region: string;
  blob: ArrayBuffer | Buffer;
  language?: string;
  prompt?: string;
};

export type AzureTranscribeAudioOutput = {
  text: string;
};

const AZURE_LOCALE_REGEX = /^[a-z]{2,3}-[A-Z]{2}$/;

const mapToAzureLocale = (language?: string): string => {
  if (!language || language.trim() === "") {
    return "en-US";
  }

  const trimmedLanguage = language.trim();

  if (trimmedLanguage.includes("-")) {
    if (AZURE_LOCALE_REGEX.test(trimmedLanguage)) {
      return trimmedLanguage;
    }
    const baseLang = trimmedLanguage.split("-")[0];
    if (baseLang) {
      return mapToAzureLocale(baseLang);
    }
  }

  const languageMap: Record<string, string> = {
    en: "en-US",
    es: "es-ES",
    fr: "fr-FR",
    de: "de-DE",
    it: "it-IT",
    pt: "pt-PT",
    ru: "ru-RU",
    ja: "ja-JP",
    ko: "ko-KR",
    zh: "zh-CN",
    ar: "ar-SA",
    nl: "nl-NL",
    sv: "sv-SE",
    tr: "tr-TR",
    pl: "pl-PL",
    ca: "ca-ES",
    id: "id-ID",
    hi: "hi-IN",
    fi: "fi-FI",
    vi: "vi-VN",
    he: "he-IL",
    uk: "uk-UA",
    el: "el-GR",
    ms: "ms-MY",
    cs: "cs-CZ",
    ro: "ro-RO",
    da: "da-DK",
    hu: "hu-HU",
    ta: "ta-IN",
    no: "nb-NO",
    th: "th-TH",
    ur: "ur-PK",
    hr: "hr-HR",
    bg: "bg-BG",
    lt: "lt-LT",
    sk: "sk-SK",
    sl: "sl-SI",
    et: "et-EE",
    lv: "lv-LV",
    fa: "fa-IR",
    sr: "sr-RS",
    bn: "bn-IN",
    af: "af-ZA",
    hy: "hy-AM",
    az: "az-AZ",
    eu: "eu-ES",
    bs: "bs-BA",
    gl: "gl-ES",
    gu: "gu-IN",
    is: "is-IS",
    kk: "kk-KZ",
    kn: "kn-IN",
    km: "km-KH",
    lo: "lo-LA",
    mk: "mk-MK",
    ml: "ml-IN",
    mr: "mr-IN",
    mn: "mn-MN",
    ne: "ne-NP",
    ps: "ps-AF",
    si: "si-LK",
    sw: "sw-KE",
    te: "te-IN",
    uz: "uz-UZ",
    cy: "cy-GB",
    am: "am-ET",
    ka: "ka-GE",
    my: "my-MM",
    so: "so-SO",
    sq: "sq-AL",
  };

  return languageMap[trimmedLanguage] || "en-US";
};

export const azureTranscribeAudio = async ({
  subscriptionKey,
  region,
  blob,
  language = "en-US",
  prompt,
}: AzureTranscriptionArgs): Promise<AzureTranscribeAudioOutput> => {
  return new Promise((resolve, reject) => {
    const azureLocale = mapToAzureLocale(language);
    const trimmedRegion = region.trim();
    const trimmedKey = subscriptionKey.trim();

    const speechConfig = sdk.SpeechConfig.fromSubscription(
      trimmedKey,
      trimmedRegion
    );
    speechConfig.speechRecognitionLanguage = azureLocale;

    const audioBuffer = blob instanceof ArrayBuffer ? blob : blob.buffer as ArrayBuffer;

    const dataView = new DataView(audioBuffer);
    const sampleRate = dataView.getUint32(24, true);
    const bitsPerSample = dataView.getUint16(34, true);
    const channels = dataView.getUint16(22, true);

    const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(sampleRate, bitsPerSample, channels);
    const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);

    const uint8Array = new Uint8Array(audioBuffer);
    const wavHeaderSize = 44;
    const audioData = uint8Array.slice(wavHeaderSize);

    pushStream.write(audioData.buffer);
    pushStream.close();

    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    if (prompt) {
      const phraseListGrammar = sdk.PhraseListGrammar.fromRecognizer(recognizer);
      const phrases = prompt.split(/[\s,]+/).filter(p => p.length > 0);
      phrases.forEach(phrase => phraseListGrammar.addPhrase(phrase));
    }

    recognizer.recognizeOnceAsync(
      (result) => {
        recognizer.close();

        if (result.reason === sdk.ResultReason.RecognizedSpeech) {
          resolve({ text: result.text });
        } else if (result.reason === sdk.ResultReason.NoMatch) {
          resolve({ text: "" });
        } else {
          reject(new Error(`Azure recognition failed: ${result.errorDetails}`));
        }
      },
      (error) => {
        recognizer.close();
        reject(new Error(`Azure API request failed: ${error}`));
      }
    );
  });
};

export type AzureTranscribeRecordingArgs = {
  subscriptionKey: string;
  region: string;
  samples: Float32Array;
  sampleRate: number;
  language?: string;
  prompt?: string;
};

/**
 * Transcribes a whole recording with continuous recognition. Unlike
 * azureTranscribeAudio (single-shot, which stops at the first pause), this
 * returns every recognized phrase and only resolves once the service has
 * reached the end of the pushed audio.
 */
export const azureTranscribeRecording = async ({
  subscriptionKey,
  region,
  samples,
  sampleRate,
  language,
  prompt,
}: AzureTranscribeRecordingArgs): Promise<AzureTranscribeAudioOutput> => {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      subscriptionKey.trim(),
      region.trim()
    );
    speechConfig.speechRecognitionLanguage = mapToAzureLocale(language);

    const pushStream = sdk.AudioInputStream.createPushStream(
      sdk.AudioStreamFormat.getWaveFormatPCM(sampleRate, 16, 1)
    );
    const recognizer = new sdk.SpeechRecognizer(
      speechConfig,
      sdk.AudioConfig.fromStreamInput(pushStream)
    );

    if (prompt) {
      const phraseListGrammar = sdk.PhraseListGrammar.fromRecognizer(recognizer);
      prompt
        .split(/[\s,]+/)
        .filter((phrase) => phrase.length > 0)
        .forEach((phrase) => phraseListGrammar.addPhrase(phrase));
    }

    const phrases: string[] = [];
    let settled = false;
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      recognizer.stopContinuousRecognitionAsync(
        () => recognizer.close(),
        () => recognizer.close()
      );
      if (error) {
        reject(error);
      } else {
        resolve({ text: phrases.join(" ") });
      }
    };

    recognizer.recognized = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
        phrases.push(e.result.text);
      }
    };
    recognizer.canceled = (_s, e) => {
      if (e.reason === sdk.CancellationReason.Error) {
        settle(
          new Error(
            `Azure recognition failed: ${e.errorDetails || `error code ${e.errorCode}`}`
          )
        );
      }
    };
    recognizer.sessionStopped = () => settle(null);

    recognizer.startContinuousRecognitionAsync(
      () => {
        const pcm16 = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        pushStream.write(pcm16.buffer);
        pushStream.close();
      },
      (error) => settle(new Error(`Azure API request failed: ${error}`))
    );
  });
};

export type AzureTestIntegrationArgs = {
  subscriptionKey: string;
  region: string;
};

export const azureTestIntegration = async ({
  subscriptionKey,
  region,
}: AzureTestIntegrationArgs): Promise<boolean> => {
  try {
    const silentBuffer = new ArrayBuffer(0);
    await azureTranscribeAudio({
      subscriptionKey,
      region,
      blob: silentBuffer,
    });
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "";
    return !errorMessage.includes("authentication") && !errorMessage.includes("subscription");
  }
};

export type AzureStreamingSession = {
  writeAudioChunk: (chunk: Float32Array) => void;
  finalize: () => Promise<string>;
  cleanup: () => void;
  /** Details of the error that canceled recognition, or null if none occurred. */
  getError: () => string | null;
};

export type CreateAzureStreamingSessionArgs = {
  subscriptionKey: string;
  region: string;
  sampleRate: number;
  language?: string;
  prompt?: string;
};

export const createAzureStreamingSession = async ({
  subscriptionKey,
  region,
  sampleRate,
  language,
  prompt,
}: CreateAzureStreamingSessionArgs): Promise<AzureStreamingSession> => {
  return new Promise((resolve, reject) => {
    const azureLocale = mapToAzureLocale(language);
    const trimmedRegion = region.trim();
    const trimmedKey = subscriptionKey.trim();

    const speechConfig = sdk.SpeechConfig.fromSubscription(
      trimmedKey,
      trimmedRegion
    );
    speechConfig.speechRecognitionLanguage = azureLocale;

    const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(
      sampleRate,
      16,
      1
    );
    const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    if (prompt) {
      const phraseListGrammar = sdk.PhraseListGrammar.fromRecognizer(recognizer);
      const phrases = prompt.split(/[\s,]+/).filter(p => p.length > 0);
      phrases.forEach(phrase => phraseListGrammar.addPhrase(phrase));
    }

    let fullTranscript = "";
    let isFinalized = false;
    let canceledError: string | null = null;

    recognizer.recognized = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
        fullTranscript += (fullTranscript ? " " : "") + e.result.text;
        console.log("[Azure Streaming] Recognized segment, length:", e.result.text.length);
      } else if (e.result.reason === sdk.ResultReason.NoMatch) {
        console.log("[Azure Streaming] No speech recognized in segment");
      }
    };

    recognizer.recognizing = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizingSpeech) {
        console.log("[Azure Streaming] Recognizing, length:", e.result.text.length);
      }
    };

    recognizer.canceled = (_s, e) => {
      console.error("[Azure Streaming] Recognition canceled:", e.errorDetails);
      if (e.reason === sdk.CancellationReason.Error) {
        console.error("[Azure Streaming] Error code:", e.errorCode);
        canceledError = e.errorDetails || `Azure error code ${e.errorCode}`;
      }
    };

    recognizer.sessionStarted = () => {
      console.log("[Azure Streaming] Session started");
    };

    recognizer.sessionStopped = () => {
      console.log("[Azure Streaming] Session stopped");
    };

    recognizer.startContinuousRecognitionAsync(
      () => {
        console.log("[Azure Streaming] Continuous recognition started");

        const writeAudioChunk = (chunk: Float32Array) => {
          if (isFinalized) {
            console.warn("[Azure Streaming] Attempted to write chunk after finalization");
            return;
          }

          const pcm16Buffer = new ArrayBuffer(chunk.length * 2);
          const pcm16View = new Int16Array(pcm16Buffer);

          for (let i = 0; i < chunk.length; i++) {
            const s = Math.max(-1, Math.min(1, chunk[i] ?? 0));
            pcm16View[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          pushStream.write(pcm16Buffer);
        };

        const finalize = (): Promise<string> => {
          return new Promise((resolveFinalize) => {
            if (isFinalized) {
              console.log("[Azure Streaming] Already finalized, returning transcript");
              resolveFinalize(fullTranscript);
              return;
            }

            isFinalized = true;
            console.log("[Azure Streaming] Finalizing session...");

            pushStream.close();

            const timeout = setTimeout(() => {
              console.log("[Azure Streaming] Timeout reached, finalizing with transcript length:", fullTranscript.length);
              recognizer.close();
              resolveFinalize(fullTranscript);
            }, 2000);

            recognizer.stopContinuousRecognitionAsync(
              () => {
                clearTimeout(timeout);
                console.log("[Azure Streaming] Recognition stopped, final transcript length:", fullTranscript.length);
                recognizer.close();
                resolveFinalize(fullTranscript);
              },
              (error) => {
                clearTimeout(timeout);
                console.error("[Azure Streaming] Error stopping recognition:", error);
                recognizer.close();
                resolveFinalize(fullTranscript);
              }
            );
          });
        };

        const cleanup = () => {
          if (!isFinalized) {
            pushStream.close();
            recognizer.close();
          }
        };

        resolve({
          writeAudioChunk,
          finalize,
          cleanup,
          getError: () => canceledError,
        });
      },
      (error) => {
        console.error("[Azure Streaming] Failed to start recognition:", error);
        recognizer.close();
        reject(new Error(`Failed to start Azure recognition: ${error}`));
      }
    );
  });
};
