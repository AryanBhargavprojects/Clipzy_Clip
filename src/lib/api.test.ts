import { test, expect, describe, beforeEach } from "bun:test";
import { ApiClient, ApiError } from "./api";

describe("ApiClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  function restoreFetch() {
    globalThis.fetch = originalFetch;
  }

  test("syncInstall sends the install ID and returns entitlements", async () => {
    globalThis.fetch = (((_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.installId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            installId: body.installId,
            isLinked: true,
            plan: "pro",
            maxClipQuality: "best",
            dailyClipLimit: null,
            clipsUsedToday: 0,
            clipsRemainingToday: null,
          }),
          { status: 200 },
        ),
      );
    }) as any);

    const client = new ApiClient("http://localhost:3000");
    const result = await client.syncInstall("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    expect(result.isLinked).toBe(true);
    expect(result.plan).toBe("pro");

    restoreFetch();
  });

  test("syncInstall throws ApiError on non-ok response", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("server error", { status: 500 }))) as any;

    const client = new ApiClient("http://localhost:3000");
    try {
      await client.syncInstall("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
    } finally {
      restoreFetch();
    }
  });

  test("ApiClient uses default base URL when none provided", () => {
    const client = new ApiClient();
    expect(client).toBeInstanceOf(ApiClient);
  });
});
