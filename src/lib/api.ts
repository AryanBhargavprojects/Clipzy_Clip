import type { ExtensionInstallSyncResponse } from "@clipzy/shared";

const DEFAULT_API_BASE = "https://api.clipzy.tech";

/**
 * Return the fetch function to use.
 * Inside a Tauri webview we use the HTTP plugin (Rust-side, no CORS).
 * Outside Tauri (e.g. unit tests, SSR) we fall back to globalThis.fetch.
 */
async function getFetch(): Promise<typeof globalThis.fetch> {
  const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (hasTauri) {
    try {
      const mod = await import("@tauri-apps/plugin-http");
      return mod.fetch as typeof globalThis.fetch;
    } catch {
      // Plugin not available — fall through.
    }
  }

  return globalThis.fetch;
}

function normalizeApiBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("API base URL cannot be empty.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("API base URL must be a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API base URL must use http:// or https://.");
  }

  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = normalizeApiBaseUrl(baseUrl ?? DEFAULT_API_BASE);
  }

  private buildUrl(path: string): string {
    return new URL(path, `${this.baseUrl}/`).toString();
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const fetch = await getFetch();
    const res = await fetch(this.buildUrl(path), init);

    if (!res.ok) {
      throw new ApiError(res.status, await res.text().catch(() => "Unknown error"));
    }

    return res.json();
  }

  async syncInstall(
    installId: string,
    extensionVersion?: string,
  ): Promise<ExtensionInstallSyncResponse> {
    return this.requestJson<ExtensionInstallSyncResponse>("/api/extension-installs/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId,
        ...(extensionVersion != null ? { extensionVersion } : {}),
      }),
    });
  }
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
    this.status = status;
  }
}
