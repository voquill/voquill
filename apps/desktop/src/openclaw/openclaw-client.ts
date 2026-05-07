import { getLogger } from "../utils/log.utils";

type OpenClawFrame = {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
  event?: string;
  seq?: number;
};

type ChatDeltaCallback = (text: string) => void;

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
};

type PendingChat = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  onDelta?: ChatDeltaCallback;
  accumulatedText: string;
};

export class OpenClawClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private pendingRequests = new Map<string, PendingRequest>();
  private pendingChats = new Map<string, PendingChat>();
  private connectResolve: ((value: void) => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(
    private gatewayUrl: string,
    private token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      this.ws = new WebSocket(this.gatewayUrl);

      this.ws.onopen = () => {
        getLogger().info("OpenClaw WebSocket opened, waiting for challenge...");
      };

      this.ws.onerror = () => {
        reject(new Error("WebSocket connection error"));
      };

      this.ws.onclose = () => {
        this.connected = false;
        getLogger().info("OpenClaw WebSocket closed");
      };

      this.ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data as string) as OpenClawFrame;
          this.handleFrame(frame);
        } catch (err) {
          getLogger().error(`Failed to parse OpenClaw frame: ${err}`);
        }
      };
    });
  }

  private handleFrame(frame: OpenClawFrame) {
    if (frame.type === "event") {
      if (frame.event === "connect.challenge") {
        this.handleChallenge();
        return;
      }
      if (frame.event === "chat") {
        this.handleChatEvent(frame);
        return;
      }
      return;
    }

    if (frame.type === "res" && frame.id) {
      const pending = this.pendingRequests.get(frame.id);
      if (pending) {
        this.pendingRequests.delete(frame.id);
        if (frame.ok) {
          pending.resolve(frame.payload);
        } else {
          pending.reject(new Error(frame.error?.message ?? "Request failed"));
        }
      }
    }
  }

  private handleChallenge() {
    const connectId = crypto.randomUUID();
    this.pendingRequests.set(connectId, {
      resolve: () => {
        this.connected = true;
        getLogger().info("OpenClaw authenticated successfully");
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
      },
      reject: (err) => {
        this.connectReject?.(err);
        this.connectResolve = null;
        this.connectReject = null;
      },
    });

    this.ws!.send(
      JSON.stringify({
        type: "req",
        id: connectId,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "webchat",
            mode: "webchat",
            version: "1.0.0",
            platform: "macos",
            displayName: "Voquill",
          },
          auth: { token: this.token },
          role: "operator",
          caps: [],
          commands: [],
        },
      }),
    );
  }

  private handleChatEvent(frame: OpenClawFrame) {
    const payload = frame.payload as Record<string, unknown>;
    const runId = payload?.runId as string | undefined;
    if (!runId) return;

    const pending = this.pendingChats.get(runId);
    if (!pending) return;

    const state = payload?.state as string;

    if (state === "delta") {
      const text = this.extractText(payload?.message);
      if (text) {
        pending.accumulatedText = text;
        pending.onDelta?.(text);
      }
    } else if (state === "final") {
      this.pendingChats.delete(runId);
      const text = this.extractText(payload?.message);
      pending.resolve(text || pending.accumulatedText || "");
    } else if (state === "error") {
      this.pendingChats.delete(runId);
      pending.reject(
        new Error((payload?.errorMessage as string) ?? "Chat error"),
      );
    } else if (state === "aborted") {
      this.pendingChats.delete(runId);
      pending.resolve(pending.accumulatedText || "[Aborted]");
    }
  }

  private extractText(message: unknown): string {
    const msg = message as { content?: { type: string; text: string }[] };
    if (!msg?.content) return "";
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
  }

  sendMessage(text: string, onDelta?: ChatDeltaCallback): Promise<string> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error("Not connected to OpenClaw"));
    }

    const idempotencyKey = crypto.randomUUID();
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      this.pendingChats.set(idempotencyKey, {
        resolve,
        reject,
        onDelta,
        accumulatedText: "",
      });

      this.pendingRequests.set(requestId, {
        resolve: () => {
          // chat.send acknowledged - response comes via chat events
        },
        reject: (err) => {
          this.pendingChats.delete(idempotencyKey);
          reject(err);
        },
      });

      this.ws!.send(
        JSON.stringify({
          type: "req",
          id: requestId,
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: text,
            idempotencyKey,
          },
        }),
      );
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.pendingRequests.clear();
    this.pendingChats.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
