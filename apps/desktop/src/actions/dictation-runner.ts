import type { AppTarget } from "@voquill/types";
import type { RecordingMode } from "../state/app.state";
import type { BaseStrategy } from "../strategies/base.strategy";
import type { TextFieldInfo } from "../types/accessibility.types";
import type { ToastAction } from "../types/toast.types";
import type {
  StopRecordingResponse,
  TranscriptionSession,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";
import {
  finishDictation as defaultFinishDictation,
  type FinishDictationOutcome,
} from "./dictation.actions";

export type DictationNotice = {
  title?: string;
  body: string;
  action?: ToastAction | null;
};

/**
 * One dictation: the session that transcribes it, the strategy that delivers
 * it, and a signal that ends it. Every step of a dictation's start and stop
 * flow goes through its own run, so once a run has ended (cancelled, or
 * replaced by a newer dictation) nothing it was doing can reach the user or
 * touch another dictation's state.
 */
export class DictationRun {
  private readonly controller = new AbortController();

  constructor(
    readonly session: TranscriptionSession,
    readonly strategy: BaseStrategy,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isActive(): boolean {
    return !this.controller.signal.aborted;
  }

  /** Cancels in-flight transcription; nothing of this run is delivered afterwards. */
  end(): void {
    if (!this.isActive) {
      return;
    }
    this.controller.abort();
    this.session.cleanup();
  }
}

export type StoppedRecording = {
  audio: StopRecordingResponse | null;
  a11yInfo: TextFieldInfo | null;
  appTarget: AppTarget | null;
};

/** Platform and UI effects the runner needs; supplied by DictationSideEffects. */
export type DictationRunnerEffects = {
  createStrategy: (mode: RecordingMode) => BaseStrategy;
  createSession: () => TranscriptionSession;
  /** Records the active mode/language and does pre-start work (style loading). */
  beginRecording: (mode: RecordingMode, language: string | null) => void;
  /** Starts the recorder (and shows the recording phase); resolves to the sample rate. */
  startRecorder: (strategy: BaseStrategy) => Promise<number>;
  /** The recording is live: arm duration timers, dim system volume. */
  onRecordingLive: () => void;
  /** Stops the recorder and captures what the transcript will be delivered into. */
  stopRecorder: (strategy: BaseStrategy) => Promise<StoppedRecording>;
  resolveToneId: (appTarget: AppTarget | null) => string | null;
  /** Returns the UI to idle (phase, timers, hotkeys, volume, recorder) and shows `notice`. */
  resetToIdle: (notice?: DictationNotice) => void;
  setStopping: (isStopping: boolean) => void;
  onStartFailed: (error: unknown) => void;
  finishDictation?: typeof defaultFinishDictation;
};

/**
 * Owns the dictation lifecycle (start, stop, cancel). Cancelling frees the
 * hotkeys at once; the cancelled run's flow keeps unwinding but, because it
 * only ever acts through its own (ended) run, it cannot paste, store or stop
 * the next dictation.
 */
export class DictationRunner {
  private current: DictationRun | null = null;
  private stopping: DictationRun | null = null;
  /** Survives across recordings while an agent conversation continues. */
  private strategy: BaseStrategy | null = null;

  constructor(private readonly getEffects: () => DictationRunnerEffects) {}

  private get effects(): DictationRunnerEffects {
    return this.getEffects();
  }

  get currentRun(): DictationRun | null {
    return this.current;
  }

  get isStopping(): boolean {
    return this.stopping !== null;
  }

  async start(args: {
    mode: RecordingMode;
    language: string | null;
  }): Promise<void> {
    this.effects.beginRecording(args.mode, args.language);
    const strategy = this.strategy ?? this.effects.createStrategy(args.mode);

    const validationError = strategy.validateAvailability();
    if (validationError) {
      this.strategy = strategy;
      this.cancel({
        title: validationError.title,
        body: validationError.body,
        action: validationError.action,
      });
      return;
    }

    let run: DictationRun | null = null;
    try {
      const session = this.effects.createSession();
      getLogger().info(`Created transcription session: ${session.name}`);
      run = new DictationRun(session, strategy);
      const thisRun = run;
      this.current?.end();
      this.current = thisRun;
      this.strategy = strategy;
      if (session.supportsStreaming()) {
        session.setInterimResultCallback((segment) => {
          if (thisRun.isActive) {
            strategy.handleInterimSegment(segment);
          }
        });
      }

      await strategy.onBeforeStart();
      if (!this.ensureCurrent(thisRun)) return;

      const sampleRate = await this.effects.startRecorder(strategy);
      if (!this.ensureCurrent(thisRun)) return;

      await session.onRecordingStart(sampleRate);
      if (!this.ensureCurrent(thisRun) || this.stopping === thisRun) return;

      this.effects.onRecordingLive();
    } catch (error) {
      getLogger().error(`Failed to start recording: ${error}`);
      if (!run || this.current === run || this.current === null) {
        this.cancel();
        this.effects.onStartFailed(error);
      }
    }
  }

  async stop(): Promise<void> {
    const run = this.current;
    if (!run || this.stopping === run) {
      getLogger().info(
        `stop skipped (${run ? "already stopping" : "no dictation"})`,
      );
      return;
    }

    this.stopping = run;
    this.effects.setStopping(true);
    try {
      const outcome = await this.finish(run).catch(
        (error): FinishDictationOutcome => {
          getLogger().error(`Error while finishing dictation: ${error}`);
          return {
            shouldContinue: false,
            notice: { body: String(error) },
          };
        },
      );
      getLogger().info(
        `stop result: shouldContinue=${outcome.shouldContinue}, active=${run.isActive}, notice=${outcome.notice?.body ?? "none"}`,
      );
      if (run.isActive && this.current === run && !outcome.shouldContinue) {
        this.cancel(outcome.notice);
      }
    } finally {
      if (this.stopping === run) {
        this.stopping = null;
        this.effects.setStopping(false);
      }
    }
  }

  /** Ends the current dictation (if any) and returns the UI to idle. */
  cancel(notice?: DictationNotice): void {
    getLogger().info(
      `Ending dictation (hasRun=${!!this.current}${notice ? `, reason=${notice.body.slice(0, 120)}` : ""})`,
    );
    const run = this.current;
    this.current = null;
    run?.end();
    void this.strategy?.cleanup();
    this.strategy = null;
    if (this.stopping) {
      this.stopping = null;
      this.effects.setStopping(false);
    }
    this.effects.resetToIdle(notice);
  }

  /** Stops transcribing the current recording but keeps the strategy (assistant type mode). */
  detachRecording(): void {
    this.current?.end();
    this.current = null;
  }

  private async finish(run: DictationRun): Promise<FinishDictationOutcome> {
    const stopped = await this.effects.stopRecorder(run.strategy);
    if (!run.isActive) {
      return { shouldContinue: false };
    }
    if (!stopped.audio) {
      return {
        shouldContinue: false,
        notice: { body: "No audio data received" },
      };
    }

    const finishDictation =
      this.effects.finishDictation ?? defaultFinishDictation;
    return await finishDictation({
      run,
      audio: stopped.audio,
      toneId: this.effects.resolveToneId(stopped.appTarget),
      a11yInfo: stopped.a11yInfo,
      appTarget: stopped.appTarget,
    });
  }

  /**
   * After an await in start: true if this run is still the current one.
   * When the run was ended meanwhile and nothing replaced it, the recorder
   * may have started after the cancel stopped it, so it is stopped again.
   */
  private ensureCurrent(run: DictationRun): boolean {
    if (run.isActive && this.current === run) {
      return true;
    }
    if (this.current === null) {
      this.effects.resetToIdle();
    }
    return false;
  }
}
