import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { API_KEY_PROVIDERS } from "@voquill/types";
import { apiRouteTestIntegration } from "@voquill/voice-ai";
import { ApiRouteGenerateTextRepo } from "./generate-text.repo";
import { ApiRouteModelProviderRepo } from "./model-provider.repo";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const fetchMock = vi.mocked(tauriFetch);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("API Route", () => {
  it("discovers the key's model IDs without a static allowlist", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [{ id: "vendor/custom-model" }, { id: "deepseek-v4.1-flash" }],
      }),
    );
    const repo = new ApiRouteModelProviderRepo();
    expect(API_KEY_PROVIDERS).toContain("api-route");
    expect(repo.supportsGenerativeTextModels()).toBe(true);
    expect(repo.supportsTranscriptionModels()).toBe(false);
    expect(await repo.getTranscriptionModels()).toEqual([]);
    expect(
      await repo.getGenerativeTextModels({ apiKey: " test-key " }),
    ).toEqual(["deepseek-v4.1-flash", "vendor/custom-model"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://global.api-route.com/v1/models",
      { headers: { Authorization: "Bearer test-key" } },
    );
  });

  it("does not fetch models without a key or substitute models after rejection", async () => {
    const repo = new ApiRouteModelProviderRepo();
    expect(await repo.getGenerativeTextModels({})).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await repo.getGenerativeTextModels({ apiKey: "invalid" })).toEqual(
      [],
    );
  });

  it("tests connectivity through the supplied fetch and surfaces authentication failures", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [] }));
    expect(
      await apiRouteTestIntegration({
        apiKey: " test-key ",
        customFetch: tauriFetch,
      }),
    ).toBe(true);
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 401, statusText: "Unauthorized" }),
    );
    await expect(
      apiRouteTestIntegration({ apiKey: "invalid", customFetch: tauriFetch }),
    ).rejects.toThrow("401 Unauthorized");
  });

  it("sends text generation to API Route using the user's selected model", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ message: { content: "Clean text." } }],
      }),
    );
    const repo = new ApiRouteGenerateTextRepo(
      " test-key ",
      "vendor/custom-model",
    );
    const output = await repo.generateText({ prompt: "Clean this transcript" });
    expect(output.text).toBe("Clean text.");
    expect(output.metadata?.inferenceDevice).toBe("API • API Route");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://global.api-route.com/v1/chat/completions",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    expect(JSON.parse(String(init?.body)).model).toBe("vendor/custom-model");
  });

  it("uses the shared streaming transport and fallback model", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const events = [];
    for await (const event of new ApiRouteGenerateTextRepo(
      "test-key",
      null,
    ).streamChat({
      messages: [{ role: "user", content: "Hello" }],
    }))
      events.push(event);
    expect(events).toContainEqual({ type: "text-delta", text: "Hello" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://global.api-route.com/v1/chat/completions",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "deepseek-v4.1-flash",
      stream: true,
    });
  });
});
