import { describe, expect, test } from "bun:test";
import { fetchJson, replaceUrlOrigin, selectFastestApiUrl } from "../src/api.ts";
import { isRetryableRequestError, isSocketConnectionClosedUnexpectedly } from "../src/http.ts";

describe("API endpoint failover", () => {
  test("keeps a separate CDN media URL instead of probing it on API origins", async () => {
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(new Uint8Array(8 * 1024));
    }) as typeof fetch;
    try {
      const selected = await selectFastestApiUrl(
        "https://raw.kiko-play-niptan.one/media/download/track.mp3",
        { requestTimeoutMs: 1_000, proxyUrl: "http://127.0.0.1:7890", apiUrls: ["https://api.asmr-200.com"] },
      );
      expect(selected).toBeUndefined();
      expect(requested).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("probes the media URL even with one configured API origin", async () => {
    let requestedPath = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requestedPath = new URL(request.url).pathname;
        return new Response(new Uint8Array(8 * 1024));
      },
    });
    try {
      const selected = await selectFastestApiUrl(
        `${server.url}audio/track.mp3?token=test`,
        { requestTimeoutMs: 1_000, proxyUrl: "", apiUrls: [server.url.origin] },
      );
      expect(selected).toBe(server.url.origin);
      expect(requestedPath).toBe("/audio/track.mp3");
    } finally {
      await server.stop(true);
    }
  });

  test("selects the fastest API origin for media downloads", async () => {
    const payload = new Uint8Array(64 * 1024);
    const slow = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await Bun.sleep(80);
        return new Response(payload);
      },
    });
    const fast = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(payload);
      },
    });
    const apiUrls = [slow.url.origin, fast.url.origin];
    try {
      const selected = await selectFastestApiUrl(
        `${slow.url}media/file.bin?token=test`,
        { requestTimeoutMs: 1_000, proxyUrl: "", apiUrls },
      );
      expect(selected).toBe(fast.url.origin);
      expect(apiUrls[0]).toBe(fast.url.origin);
      expect(replaceUrlOrigin("https://source.example/media/file.bin?token=test", selected!))
        .toBe(`${fast.url}media/file.bin?token=test`);
    } finally {
      await Promise.all([slow.stop(true), fast.stop(true)]);
    }
  });

  test("switches after an unexpected socket close and promotes the working endpoint", async () => {
    const primary = "https://api.asmr-200.com";
    const fallback = "https://api.asmr-100.com";
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const requestUrl = String(input);
      requested.push(requestUrl);
      if (new URL(requestUrl).origin === primary) {
        throw new Error("The socket connection was closed unexpectedly");
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    const config = { requestTimeoutMs: 1_000, maxRetries: 2, proxyUrl: "", apiUrls: [primary, fallback] };
    try {
      expect(await fetchJson<{ ok: boolean }>(`${primary}/api/test`, config)).toEqual({ ok: true });
      expect(requested.map((value) => new URL(value).origin)).toEqual([primary, fallback]);
      expect(config.apiUrls).toEqual([fallback, primary]);

      requested.length = 0;
      expect(await fetchJson<{ ok: boolean }>(`${primary}/api/test-2`, config)).toEqual({ ok: true });
      expect(requested.map((value) => new URL(value).origin)).toEqual([fallback]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("recognizes an unexpected socket close", () => {
    const error = new Error("The socket connection was closed unexpectedly");
    expect(isSocketConnectionClosedUnexpectedly(error)).toBeTrue();
    expect(isRetryableRequestError(error)).toBeTrue();
    expect(isSocketConnectionClosedUnexpectedly(new Error("other network error"))).toBeFalse();
  });
});
