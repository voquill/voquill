export const createAbortError = (): Error => {
  const error = new Error("Cancelled");
  error.name = "AbortError";
  return error;
};

/** Rejects as soon as `signal` aborts, even if `promise` cannot be cancelled. */
export const abortable = <T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

export const abortableDelay = (
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> =>
  abortable(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);

/** Rejects after `timeoutMs` or when `signal` aborts; `promise` keeps running. */
export const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> =>
  abortable(
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    }),
    signal,
  );

/**
 * Runs one cancellable attempt, aborting it after `timeoutMs` (no limit
 * when null) or when `parent` aborts, so a hung request ends with a timeout
 * error instead of waiting forever.
 */
export const runWithAttemptTimeout = async <T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | null,
  parent?: AbortSignal,
): Promise<T> => {
  const attempt = new AbortController();
  const cancel = () => attempt.abort();
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) {
    attempt.abort();
  }
  let timedOut = false;
  const timer =
    timeoutMs === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          attempt.abort();
        }, timeoutMs);
  try {
    return await abortable(run(attempt.signal), attempt.signal);
  } catch (error) {
    if (timedOut && timeoutMs !== null) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }
};
