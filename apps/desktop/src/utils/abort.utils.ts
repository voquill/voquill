export const createAbortError = (): Error => {
  const error = new Error("Cancelled");
  error.name = "AbortError";
  return error;
};

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

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
