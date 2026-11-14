/** Covers everything before audio can flow: token fetch, socket open, handshake. */
export const STREAM_CONNECT_TIMEOUT_MS = 10_000;
/**
 * An upload that has not drained at all for this long is dead. Measured in
 * WKWebView, a healthy-but-slow socket drains `bufferedAmount` in coarse steps
 * up to ~3.5s apart, so this leaves ~3x headroom.
 */
export const UPLOAD_STALL_TIMEOUT_MS = 10_000;
const UPLOAD_POLL_INTERVAL_MS = 250;

/**
 * Waits for `ws.bufferedAmount` to drain after the last audio was queued.
 * Progress is any decrease or any message from the provider. When a socket
 * that has been seen draining (`armed`) makes no progress for
 * `stallTimeoutMs`, the upload is dead and this rejects. A socket never seen
 * draining is not trusted to report it (the value could be stuck), so after
 * the same wait this resolves and the caller's own timeout takes over: an
 * unreliable `bufferedAmount` can delay a dead stream's failure but can never
 * fail a healthy one.
 */
export const waitForUploadDrain = (args: {
  ws: WebSocket;
  armed: boolean;
  getLastMessageAt: () => number;
  signal: AbortSignal;
  stallTimeoutMs?: number;
}): Promise<void> => {
  const stallTimeoutMs = args.stallTimeoutMs ?? UPLOAD_STALL_TIMEOUT_MS;
  if (args.ws.bufferedAmount === 0 || args.signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let armed = args.armed;
    let lowest = args.ws.bufferedAmount;
    let lastMessageAt = args.getLastMessageAt();
    let lastProgressAt = Date.now();

    const finish = (error?: Error) => {
      clearInterval(interval);
      args.signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish();
    const interval = setInterval(() => {
      const buffered = args.ws.bufferedAmount;
      if (buffered === 0) {
        finish();
        return;
      }
      const messageAt = args.getLastMessageAt();
      if (buffered < lowest) {
        armed = true;
        lowest = buffered;
        lastProgressAt = Date.now();
      } else if (messageAt > lastMessageAt) {
        lastMessageAt = messageAt;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt >= stallTimeoutMs) {
        finish(
          armed
            ? new Error(
                `Upload stalled: ${buffered} bytes unsent with no progress for ${stallTimeoutMs / 1000}s`,
              )
            : undefined,
        );
      }
    }, UPLOAD_POLL_INTERVAL_MS);
    args.signal.addEventListener("abort", onAbort, { once: true });
  });
};

/** Closes a socket we are done with without firing its handlers again. */
export const closeSocket = (ws: WebSocket | null): void => {
  if (!ws) {
    return;
  }
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  if (ws.readyState !== WebSocket.CLOSED) {
    ws.close();
  }
};

// 1006: dropped without a close frame; 1011: provider-side error.
export const getAbnormalCloseFailure = (event: CloseEvent): string | null =>
  event.code === 1006 || event.code === 1011
    ? `Connection closed abnormally (code=${event.code}${event.reason ? `, reason=${event.reason}` : ""})`
    : null;
