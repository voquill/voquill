import { describe, expect, it } from "vitest";
import type { NoteAskEvent } from "../pipelines/base-note.pipeline";
import {
  CloudNoteRepo,
  getNotesErrorHandling,
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
    getAuthHeaders: async (forceRefresh) => {
      if (forceRefresh) refreshed++;
      return { Authorization: `Bearer token-${refreshed}` };
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
      getAuthHeaders: async () => ({}),
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
