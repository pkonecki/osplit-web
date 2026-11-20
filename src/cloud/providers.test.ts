import { describe, expect, it } from "vitest";
import { apiArg, DROPBOX_CHUNK, DropboxStore, dropboxConfig } from "./dropbox";
import {
  authorizedFetcher,
  codeChallenge,
  exchangeCode,
  type Fetcher,
  ReconnectNeeded,
  signInUrl,
  takePendingSignIn,
  type Tokens,
  withRetry,
} from "./oauth";
import { ONEDRIVE_CHUNK, OneDriveStore, oneDriveConfig } from "./onedrive";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A fetch that records calls and answers from `respond`. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fn, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const noSleep = () => Promise.resolve();

describe("OAuth sign-in", () => {
  it("builds a PKCE sign-in URL and accepts only its own redirect", async () => {
    const storage = new MemoryStorage();
    const url = new URL(await signInUrl(dropboxConfig("app-key"), "https://example.com/app/", storage));
    expect(url.origin + url.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("app-key");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/app/");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const saved = JSON.parse(storage.getItem("osplit-cloud-sign-in")!);
    expect(url.searchParams.get("state")).toBe(saved.state);
    expect(url.searchParams.get("code_challenge")).toBe(await codeChallenge(saved.verifier));

    const pending = takePendingSignIn(new URLSearchParams({ code: "c", state: saved.state }), storage);
    expect(pending).toEqual({ provider: "dropbox", verifier: saved.verifier, state: saved.state });
    // Used once.
    expect(takePendingSignIn(new URLSearchParams({ code: "c", state: saved.state }), storage)).toBeNull();
  });

  it("ignores a redirect with another state, and forgets the pending sign-in", async () => {
    const storage = new MemoryStorage();
    await signInUrl(dropboxConfig("app-key"), "https://example.com/", storage);
    const saved = JSON.parse(storage.getItem("osplit-cloud-sign-in")!);
    expect(takePendingSignIn(new URLSearchParams({ code: "c", state: "forged" }), storage)).toBeNull();
    expect(takePendingSignIn(new URLSearchParams({ code: "c", state: saved.state }), storage)).toBeNull();
    // Not a sign-in redirect at all: nothing is consumed.
    await signInUrl(dropboxConfig("app-key"), "https://example.com/", storage);
    expect(takePendingSignIn(new URLSearchParams({ shared: "1" }), storage)).toBeNull();
    expect(storage.getItem("osplit-cloud-sign-in")).not.toBeNull();
  });

  it("computes the RFC 7636 code challenge", async () => {
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("asks OneDrive for the app folder and offline access", async () => {
    const url = new URL(await signInUrl(oneDriveConfig("client"), "https://example.com/", new MemoryStorage()));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")).toBe("Files.ReadWrite.AppFolder offline_access");
  });

  it("exchanges the code for tokens", async () => {
    const { fn, calls } = fakeFetch(() =>
      json({ access_token: "at", refresh_token: "rt", expires_in: 14400 })
    );
    const tokens = await exchangeCode(dropboxConfig("key"), "code", "verifier", "https://example.com/", fn);
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 14000 * 1000);
    const body = new URLSearchParams(String(calls[0].body));
    expect(Object.fromEntries(body)).toEqual({
      client_id: "key",
      grant_type: "authorization_code",
      code: "code",
      code_verifier: "verifier",
      redirect_uri: "https://example.com/",
    });
  });
});

describe("authorized requests", () => {
  const config = oneDriveConfig("client");

  function session(tokens: Tokens) {
    let current = tokens;
    return { load: () => current, save: (next: Tokens) => (current = next), get: () => current };
  }

  it("refreshes an expired token first, keeping a rotated refresh token", async () => {
    const tokens = session({ accessToken: "old", refreshToken: "r1", expiresAt: 0 });
    const { fn, calls } = fakeFetch((call) =>
      call.url === config.tokenUrl
        ? json({ access_token: "new", refresh_token: "r2", expires_in: 3600 })
        : new Response("ok")
    );
    const fetcher = authorizedFetcher(config, tokens.load, tokens.save, { fetchFn: fn, sleep: noSleep });
    await fetcher("https://graph.microsoft.com/v1.0/x");
    expect(calls.map((call) => call.url)).toEqual([config.tokenUrl, "https://graph.microsoft.com/v1.0/x"]);
    expect(calls[1].headers.get("Authorization")).toBe("Bearer new");
    expect(tokens.get().refreshToken).toBe("r2");
    expect(new URLSearchParams(String(calls[0].body)).get("refresh_token")).toBe("r1");
  });

  it("refreshes and retries once when the token is rejected", async () => {
    const tokens = session({ accessToken: "old", refreshToken: "r", expiresAt: Date.now() + 1e6 });
    const { fn, calls } = fakeFetch((call) => {
      if (call.url === config.tokenUrl) return json({ access_token: "new", expires_in: 3600 });
      return call.headers.get("Authorization") === "Bearer new"
        ? new Response("ok")
        : new Response("", { status: 401 });
    });
    const fetcher = authorizedFetcher(config, tokens.load, tokens.save, { fetchFn: fn, sleep: noSleep });
    expect(await (await fetcher("https://api/x")).text()).toBe("ok");
    expect(calls).toHaveLength(3);
    // Without a new refresh token, the old one is kept.
    expect(tokens.get().refreshToken).toBe("r");
  });

  it("asks to sign in again when the refresh token no longer works", async () => {
    const tokens = session({ accessToken: "old", refreshToken: "r", expiresAt: 0 });
    const { fn } = fakeFetch(() => json({ error: "invalid_grant" }, 400));
    const fetcher = authorizedFetcher(config, tokens.load, tokens.save, { fetchFn: fn, sleep: noSleep });
    await expect(fetcher("https://api/x")).rejects.toBeInstanceOf(ReconnectNeeded);
  });

  it("retries throttled and failed requests", async () => {
    let attempt = 0;
    const waits: number[] = [];
    const response = await withRetry(async () => {
      attempt++;
      if (attempt === 1) return new Response("", { status: 429, headers: { "Retry-After": "3" } });
      if (attempt === 2) throw new TypeError("network");
      if (attempt === 3) return new Response("", { status: 503 });
      return new Response("ok");
    }, async (ms) => {
      waits.push(ms);
    });
    expect(await response.text()).toBe("ok");
    expect(waits).toEqual([3000, 2000, 4000]);
  });
});

/** A fetcher that answers without tokens. */
function plain(respond: (call: Call) => Response | Promise<Response>) {
  const fake = fakeFetch(respond);
  return { fetcher: fake.fn as Fetcher, calls: fake.calls, fn: fake.fn };
}

describe("Dropbox", () => {
  it("escapes non-ASCII characters in the argument header", () => {
    expect(apiArg({ path: "/é" })).toBe('{"path":"/\\u00e9"}');
  });

  it("lists a folder across pages, and nothing for a missing folder", async () => {
    const { fetcher, calls } = plain((call) => {
      if (call.url.endsWith("/files/list_folder")) {
        const path = JSON.parse(String(call.body)).path;
        if (path === "/missing") return json({ error_summary: "path/not_found/.." }, 409);
        return json({ entries: [{ ".tag": "folder", name: "a" }], cursor: "c1", has_more: true });
      }
      return json({ entries: [{ ".tag": "file", name: "b", size: 4 }], cursor: "c2", has_more: false });
    });
    const store = new DropboxStore(fetcher);
    expect(await store.list("projects")).toEqual([
      { name: "a", folder: true, size: 0 },
      { name: "b", folder: false, size: 4 },
    ]);
    expect(JSON.parse(String(calls[1].body))).toEqual({ cursor: "c1" });
    expect(await store.list("missing")).toEqual([]);
  });

  it("reads a file, and null for a missing one", async () => {
    const { fetcher, calls } = plain((call) =>
      JSON.parse(call.headers.get("Dropbox-API-Arg")!).path === "/a/b"
        ? new Response("data")
        : json({ error_summary: "path/not_found/" }, 409)
    );
    const store = new DropboxStore(fetcher);
    expect(await (await store.read("a/b"))!.text()).toBe("data");
    expect(calls[0].url).toBe("https://content.dropboxapi.com/2/files/download");
    expect(await store.read("a/c")).toBeNull();
  });

  it("uploads a small file in one request", async () => {
    const { fetcher, calls } = plain(() => json({}));
    await new DropboxStore(fetcher).write("p/x", new Blob(["abc"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://content.dropboxapi.com/2/files/upload");
    expect(JSON.parse(calls[0].headers.get("Dropbox-API-Arg")!)).toEqual({ path: "/p/x", mode: "overwrite", mute: true });
  });

  it("uploads a large file in a session", async () => {
    const { fetcher, calls } = plain((call) =>
      call.url.endsWith("/start") ? json({ session_id: "s" }) : json({})
    );
    const sent: number[] = [];
    const size = DROPBOX_CHUNK * 2 + 5;
    await new DropboxStore(fetcher).write("p/big", new Blob([new Uint8Array(size)]), (n) => sent.push(n));
    expect(calls.map((call) => call.url.split("/2/")[1])).toEqual([
      "files/upload_session/start",
      "files/upload_session/append_v2",
      "files/upload_session/finish",
    ]);
    expect(JSON.parse(calls[1].headers.get("Dropbox-API-Arg")!).cursor).toEqual({ session_id: "s", offset: DROPBOX_CHUNK });
    expect(JSON.parse(calls[2].headers.get("Dropbox-API-Arg")!)).toEqual({
      cursor: { session_id: "s", offset: DROPBOX_CHUNK * 2 },
      commit: { path: "/p/big", mode: "overwrite", mute: true },
    });
    expect((calls[2].body as Blob).size).toBe(5);
    expect(sent).toEqual([DROPBOX_CHUNK, DROPBOX_CHUNK * 2, size]);
  });

  it("treats removing a missing path as done, and reports other errors", async () => {
    const { fetcher } = plain((call) =>
      JSON.parse(String(call.body)).path === "/gone"
        ? json({ error_summary: "path_lookup/not_found/" }, 409)
        : json({ error_summary: "too_many_write_operations/" }, 409)
    );
    const store = new DropboxStore(fetcher);
    await store.remove("gone");
    await expect(store.remove("busy")).rejects.toThrow(/too_many_write_operations/);
  });
});

describe("OneDrive", () => {
  const root = "https://graph.microsoft.com/v1.0/me/drive/special/approot";

  it("lists a folder across pages, and nothing for a missing folder", async () => {
    const { fetcher, calls } = plain((call) => {
      if (call.url.includes("missing")) return json({ error: { code: "itemNotFound" } }, 404);
      if (call.url === "next") return json({ value: [{ name: "b", size: 2, file: {} }] });
      return json({ value: [{ name: "a", folder: { childCount: 1 } }], "@odata.nextLink": "next" });
    });
    const store = new OneDriveStore(fetcher);
    expect(await store.list("projects/x y")).toEqual([
      { name: "a", folder: true, size: 0 },
      { name: "b", folder: false, size: 2 },
    ]);
    expect(calls[0].url).toBe(`${root}:/projects/x%20y:/children?$select=name,size,folder&$top=1000`);
    expect(await store.list("missing")).toEqual([]);
  });

  it("reads a file through its download URL, without the token", async () => {
    const { fetcher } = plain((call) =>
      call.url.endsWith("missing")
        ? json({}, 404)
        : json({ "@microsoft.graph.downloadUrl": "https://download/file" })
    );
    const downloads = fakeFetch(() => new Response("data"));
    const store = new OneDriveStore(fetcher, downloads.fn);
    expect(await (await store.read("p/f"))!.text()).toBe("data");
    expect(downloads.calls[0].url).toBe("https://download/file");
    expect(downloads.calls[0].headers.has("Authorization")).toBe(false);
    expect(await store.read("p/missing")).toBeNull();
  });

  it("uploads a small file in one request", async () => {
    const { fetcher, calls } = plain(() => json({}, 201));
    await new OneDriveStore(fetcher).write("p/x", new Blob(["abc"]));
    expect(calls[0]).toMatchObject({ url: `${root}:/p/x:/content`, method: "PUT" });
  });

  it("uploads a large file in an upload session", async () => {
    const { fetcher, calls } = plain(() => json({ uploadUrl: "https://upload/session" }));
    const uploads = fakeFetch(() => json({}, 202));
    const size = ONEDRIVE_CHUNK + 100;
    await new OneDriveStore(fetcher, uploads.fn).write("p/big", new Blob([new Uint8Array(size)]));
    expect(calls[0]).toMatchObject({ url: `${root}:/p/big:/createUploadSession`, method: "POST" });
    expect(uploads.calls.map((call) => call.headers.get("Content-Range"))).toEqual([
      `bytes 0-${ONEDRIVE_CHUNK - 1}/${size}`,
      `bytes ${ONEDRIVE_CHUNK}-${size - 1}/${size}`,
    ]);
    expect(uploads.calls.every((call) => !call.headers.has("Authorization"))).toBe(true);
    expect(ONEDRIVE_CHUNK % (320 * 1024)).toBe(0);
  });

  it("removes a path, treating a missing one as done", async () => {
    const { fetcher, calls } = plain((call) => new Response(null, { status: call.url.endsWith("gone") ? 404 : 204 }));
    const store = new OneDriveStore(fetcher);
    await store.remove("p/a");
    await store.remove("p/gone");
    expect(calls[0]).toMatchObject({ url: `${root}:/p/a`, method: "DELETE" });
  });
});
