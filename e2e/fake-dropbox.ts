import type { BrowserContext, Route } from "@playwright/test";

/**
 * A Dropbox app folder in memory, answering the API calls OSplit makes
 * (src/cloud/dropbox.ts), for tests of cloud sync. Paths are like
 * "/projects/<id>/project.json".
 */
export class FakeDropbox {
  readonly files = new Map<string, Buffer>();
  quota = { used: 5_000_000_000, allocated: 2_000_000_000_000 };

  async install(context: BrowserContext): Promise<void> {
    await context.route("https://api.dropboxapi.com/**", (route) => this.api(route));
    await context.route("https://content.dropboxapi.com/**", (route) => this.content(route));
  }

  /** Signs the page in, as if back from Dropbox's sign-in page. */
  static connection(): string {
    return JSON.stringify({
      provider: "dropbox",
      account: "Test Player",
      tokens: { accessToken: "test-token", refreshToken: "test-refresh", expiresAt: Date.now() + 3600_000 },
    });
  }

  /** The project manifest stored for `id`, parsed. */
  manifest(id: string): { project: Record<string, unknown> } & Record<string, unknown> {
    return JSON.parse(this.files.get(`/projects/${id}/project.json`)!.toString());
  }

  setManifest(id: string, manifest: unknown): void {
    this.files.set(`/projects/${id}/project.json`, Buffer.from(JSON.stringify(manifest)));
  }

  private headers(): Record<string, string> {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    };
  }

  private json(route: Route, value: unknown, status = 200): Promise<void> {
    return route.fulfill({
      status,
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  }

  private async api(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: this.headers() });
    const endpoint = new URL(request.url()).pathname.replace(/^\/2\//, "");
    const args = request.postData() ? JSON.parse(request.postData()!) : {};
    switch (endpoint) {
      case "files/list_folder": {
        const prefix = `${args.path}/`;
        const entries = new Map<string, { ".tag": string; name: string; size?: number }>();
        for (const [path, data] of this.files) {
          if (!path.startsWith(prefix)) continue;
          const [name, ...rest] = path.slice(prefix.length).split("/");
          entries.set(name, rest.length ? { ".tag": "folder", name } : { ".tag": "file", name, size: data.length });
        }
        if (!entries.size) return this.json(route, { error_summary: "path/not_found/" }, 409);
        return this.json(route, { entries: [...entries.values()], cursor: "c", has_more: false });
      }
      case "files/delete_v2":
        for (const path of [...this.files.keys()]) {
          if (path === args.path || path.startsWith(`${args.path}/`)) this.files.delete(path);
        }
        return this.json(route, {});
      case "users/get_space_usage":
        return this.json(route, { used: this.quota.used, allocation: { ".tag": "individual", allocated: this.quota.allocated } });
      case "users/get_current_account":
        return this.json(route, { name: { display_name: "Test Player" } });
      case "auth/token/revoke":
        return this.json(route, null);
      default:
        return this.json(route, { error_summary: `unknown ${endpoint}` }, 400);
    }
  }

  private async content(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: this.headers() });
    const endpoint = new URL(request.url()).pathname.replace(/^\/2\//, "");
    const arg = JSON.parse(request.headers()["dropbox-api-arg"] ?? "{}");
    if (endpoint === "files/download") {
      const data = this.files.get(arg.path);
      if (!data) return this.json(route, { error_summary: "path/not_found/" }, 409);
      return route.fulfill({ status: 200, headers: { ...this.headers(), "Content-Type": "application/octet-stream" }, body: data });
    }
    if (endpoint === "files/upload") {
      this.files.set(arg.path, request.postDataBuffer() ?? Buffer.alloc(0));
      return this.json(route, { name: arg.path.split("/").pop() });
    }
    return this.json(route, { error_summary: `unknown ${endpoint}` }, 400);
  }
}
