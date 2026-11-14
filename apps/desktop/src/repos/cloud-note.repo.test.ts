import { describe, expect, it } from "vitest";
import type { NoteAskEvent } from "../pipelines/base-note.pipeline";
import {
  CloudNoteRepo,
  getNotesErrorHandling,
  NOTE_ASK_LIMITS,
  NotesAccountChangedError,
  NotesApiError,
  NotesNetworkError,
  parseSseStream,
} from "./cloud-note.repo";

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

type Call = { url: string; init: RequestInit; token: string };

const repoWith = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  let refreshed = 0;
  const repo = new CloudNoteRepo({
    baseUrl: "https://api.test",
    getAuth: async (forceRefresh) => {
      if (forceRefresh) refreshed++;
      return {
        uid: "u1",
        headers: { Authorization: `Bearer token-${refreshed}` },
      };
    },
    fetch: async (url, init) => {
      const call = {
        url,
        init,
        token: (init.headers as Record<string, string>).Authorization,
      };
      calls.push(call);
      return respond(call);
    },
  });
  return { repo, calls, refreshes: () => refreshed };
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const collect = async (events: AsyncGenerator<NoteAskEvent>) => {
  const all: NoteAskEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
};

describe("parseSseStream", () => {
  it("parses events split across chunks and skips keepalive comments", async () => {
    const events = [];
    for await (const event of parseSseStream(
      streamOf(
        ": keepalive\n\nevent: sou",
        'rces\ndata: {"sources":[]}\r\n\r\nevent: delta\ndata: {"te',
        'xt":"Hi"}\n\n',
      ),
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { event: "sources", data: '{"sources":[]}' },
      { event: "delta", data: '{"text":"Hi"}' },
    ]);
  });
});

describe("CloudNoteRepo.ask", () => {
  const sse = (body: string) =>
    new Response(streamOf(body), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

  it("streams sources, deltas and the final answer", async () => {
    const { repo, calls } = repoWith(() =>
      sse(
        'event: sources\ndata: {"sources":[{"noteId":"n1","title":"Plan"}]}\n\n' +
          'event: delta\ndata: {"text":"Yes "}\n\n' +
          'event: delta\ndata: {"text":"[1]."}\n\n' +
          'event: done\ndata: {"answer":"Yes [1]."}\n\n',
      ),
    );
    const events = await collect(
      repo.ask({ question: "q?", noteId: "n1", history: [] }),
    );
    expect(events).toEqual([
      { type: "sources", sources: [{ noteId: "n1", title: "Plan" }] },
      { type: "delta", text: "Yes " },
      { type: "delta", text: "[1]." },
      {
        type: "done",
        answer: "Yes [1].",
        sources: [{ noteId: "n1", title: "Plan" }],
      },
    ]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      question: "q?",
      noteId: "n1",
      history: [],
      stream: true,
    });
  });

  it("throws a JSON error that arrives before the stream starts", async () => {
    const { repo } = repoWith(() =>
      json(409, {
        error: { code: "transcript_unavailable", message: "not yet" },
      }),
    );
    await expect(
      collect(repo.ask({ question: "q", noteId: "n", history: [] })),
    ).rejects.toMatchObject({ status: 409, code: "transcript_unavailable" });
  });

  it("ends with an error for a mid-stream failure or a dropped stream", async () => {
    const failed = repoWith(() =>
      sse(
        'event: sources\ndata: {"sources":[]}\n\nevent: delta\ndata: {"text":"Part"}\n\n' +
          'event: error\ndata: {"code":"ask_failed","message":"x"}\n\n',
      ),
    );
    expect(
      (
        await collect(
          failed.repo.ask({ question: "q", noteId: null, history: [] }),
        )
      ).at(-1),
    ).toEqual({ type: "error", message: "ask_failed" });

    const dropped = repoWith(() =>
      sse('event: sources\ndata: {"sources":[]}\n\n'),
    );
    expect(
      (
        await collect(
          dropped.repo.ask({ question: "q", noteId: null, history: [] }),
        )
      ).at(-1),
    ).toEqual({ type: "error", message: "ask_incomplete" });
  });
});

describe("CloudNoteRepo requests", () => {
  it("refreshes the token once on 401", async () => {
    const { repo, calls, refreshes } = repoWith(({ token }) =>
      token === "Bearer token-0"
        ? json(401, { error: { code: "unauthenticated", message: "expired" } })
        : json(200, { notes: [], nextCursor: null }),
    );
    await repo.listNotesPage(null);
    expect(refreshes()).toBe(1);
    expect(calls.map((call) => call.token)).toEqual([
      "Bearer token-0",
      "Bearer token-1",
    ]);
  });

  it("pages through every note", async () => {
    const { repo, calls } = repoWith(({ url }) =>
      url.includes("cursor=c1")
        ? json(200, { notes: [{ id: "b" }], nextCursor: null })
        : json(200, { notes: [{ id: "a" }], nextCursor: "c1" }),
    );
    expect((await repo.listAllNotes()).map((note) => note.id)).toEqual([
      "a",
      "b",
    ]);
    expect(calls[0].url).toBe("https://api.test/v1/notes?limit=100");
  });

  it("sends the upload body with the WAV content type and the size", async () => {
    const { repo, calls } = repoWith(() =>
      json(200, { uploadUrl: "https://upload" }),
    );
    expect(
      await repo.requestSegmentUpload("n", "s", {
        durationMs: 1000,
        sizeBytes: 32044,
        index: 2,
      }),
    ).toBe("https://upload");
    expect(calls[0].url).toBe("https://api.test/v1/notes/n/segments/s/upload");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      contentType: "audio/wav",
      durationMs: 1000,
      sizeBytes: 32044,
      index: 2,
    });
  });

  it("reads error codes and segment ids, and reports network failures", async () => {
    const { repo } = repoWith(() =>
      json(409, {
        error: {
          code: "audio_missing",
          message: "upload again",
          details: { segmentIds: ["s1"] },
        },
      }),
    );
    await expect(repo.processNote("n", {})).rejects.toMatchObject({
      code: "audio_missing",
      segmentIds: ["s1"],
    });

    const offline = new CloudNoteRepo({
      getAuth: async () => ({ uid: "u1", headers: {} }),
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(offline.deleteNote("n")).rejects.toBeInstanceOf(
      NotesNetworkError,
    );
  });
});

describe("cooldown errors", () => {
  it("reads Retry-After from the details or the header", async () => {
    const { repo } = repoWith(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "regenerate_cooldown", message: "wait" },
          }),
          { status: 429, headers: { "Retry-After": "95" } },
        ),
    );
    await expect(repo.regenerateNote("n")).rejects.toMatchObject({
      code: "regenerate_cooldown",
      retryAfterSeconds: 95,
    });
  });
});

describe("getNotesErrorHandling", () => {
  it.each([
    [new NotesNetworkError("x"), "retry"],
    [new NotesApiError(503, "queue_unavailable", ""), "retry"],
    [new NotesApiError(500, "internal_error", ""), "retry"],
    [new NotesApiError(429, "too_many_upload_sessions", ""), "blocked"],
    [new NotesApiError(409, "note_deleted", ""), "blocked"],
    [new NotesApiError(403, "audio_quota_exceeded", ""), "blocked"],
    [new NotesApiError(429, "regenerate_cooldown", ""), "blocked"],
    [new NotesApiError(429, "too_many_processing", ""), "busy"],
    [new NotesApiError(429, "too_many_pending_uploads", ""), "blocked"],
    [new NotesApiError(503, "notes_unavailable", ""), "retry"],
    [new NotesApiError(413, "segment_too_large", ""), "blocked"],
    [new NotesApiError(404, "note_not_found", ""), "missing"],
  ] as const)("%o is %s", (error, handling) => {
    expect(getNotesErrorHandling(error)).toBe(handling);
  });
});

describe("CloudNoteRepo account binding and timeouts", () => {
  const noteBody = { note: { id: "n", segments: [] } };

  it("refuses to send when the signed-in user is not the note's owner (S5)", async () => {
    let fetched = 0;
    const repo = new CloudNoteRepo({
      getAuth: async () => ({ uid: "account-b", headers: {} }),
      fetch: async () => {
        fetched++;
        return json(200, noteBody);
      },
    }).forOwner("account-a");
    await expect(repo.getNote("n")).rejects.toBeInstanceOf(
      NotesAccountChangedError,
    );
    await expect(
      repo.putNote("n", {
        title: "t",
        titleSource: "user",
        personalNotes: "private",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(NotesAccountChangedError);
    expect(fetched).toBe(0);
  });

  it("refuses quietly when nobody is signed in (S5)", async () => {
    const repo = new CloudNoteRepo({
      getAuth: async () => null,
      fetch: async () => json(200, noteBody),
    }).forOwner("account-a");
    await expect(repo.getNote("n")).rejects.toBeInstanceOf(
      NotesAccountChangedError,
    );
  });

  it("sends for the owner", async () => {
    const repo = new CloudNoteRepo({
      getAuth: async () => ({ uid: "account-a", headers: {} }),
      fetch: async () => json(200, noteBody),
    }).forOwner("account-a");
    await expect(repo.getNote("n")).resolves.toMatchObject({ id: "n" });
  });

  it("gives up on a request that never answers (S7)", async () => {
    const repo = new CloudNoteRepo({
      timeoutMs: 20,
      getAuth: async () => ({ uid: "u1", headers: {} }),
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    const failure = await repo.getNote("n").catch((error) => error);
    expect(failure).toBeInstanceOf(NotesNetworkError);
    expect(getNotesErrorHandling(failure)).toBe("retry");
  });
});

describe("CloudNoteRepo.ask caps (S6)", () => {
  it("sends at most 20 history messages of at most 8,000 characters and a 2,000-character question", async () => {
    const { repo, calls } = repoWith(
      () =>
        new Response(streamOf('event: done\ndata: {"answer":"ok"}\n\n'), {
          status: 200,
        }),
    );
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: `${i}`.padEnd(20_000, "x"),
    }));
    await collect(
      repo.ask({ question: "q".repeat(5_000), noteId: null, history }),
    );
    const body = JSON.parse(String(calls[0].init.body)) as {
      question: string;
      history: { content: string }[];
    };
    expect(body.question).toHaveLength(NOTE_ASK_LIMITS.maxQuestionChars);
    expect(body.history).toHaveLength(20);
    expect(body.history[0].content.startsWith("10")).toBe(true);
    expect(
      body.history.every(
        (m) => m.content.length === NOTE_ASK_LIMITS.maxHistoryMessageChars,
      ),
    ).toBe(true);
  });
});
