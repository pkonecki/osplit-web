import { createYtDlp } from "@project516/yt-dlp-wasm";
import { getModel, putModel } from "./storage";

type Request =
  | { type: "download"; id: string; url: string }
  | { type: "update"; id: string; installedVersion: string | null };

type Response =
  | { type: "progress"; id: string; progress: number; stage: string }
  | { type: "downloaded"; id: string; name: string; blob: Blob }
  | { type: "updated"; id: string; version: string }
  | { type: "error"; id: string; message: string };

const UNSUPPORTED_BROWSER = "UnsupportedBrowserError";

self.addEventListener("message", (event: MessageEvent<Request>) => {
  if (event.data.type === "download") void download(event.data);
  else void update(event.data);
});

async function createRuntime(id: string) {
  const cached = await getModel("yt-dlp/current-wheel");
  let wheelURL: string;
  if (cached) {
    wheelURL = URL.createObjectURL(cached.blob);
  } else {
    const metadataResponse = await fetch("/yt-dlp/wheel.json");
    if (!metadataResponse.ok) {
      throw new Error("The bundled yt-dlp runtime is missing.");
    }
    const metadata = await metadataResponse.json() as { wheel: string };
    wheelURL = new URL(`/yt-dlp/${metadata.wheel}`, self.location.origin).href;
  }
  postMessage(
    {
      type: "progress",
      id,
      progress: 5,
      stage: "Starting browser yt-dlp runtime",
    } satisfies Response,
  );
  try {
    const runtime = await createYtDlp({ wheelURL });
    return {
      runtime,
      dispose: async () => {
        await runtime.close();
        if (wheelURL.startsWith("blob:")) URL.revokeObjectURL(wheelURL);
      },
    };
  } catch (error) {
    if (wheelURL.startsWith("blob:")) URL.revokeObjectURL(wheelURL);
    const detail = error instanceof Error
      ? error.message
      : "yt-dlp could not start.";
    if (/JSPI|version|not supported/i.test(detail)) {
      const unsupported = new Error(
        "Client URL downloading needs a browser with JavaScript Promise Integration (Chrome 137+, Firefox 153+, or Safari 27+). You can still import a local audio file.",
      );
      unsupported.name = UNSUPPORTED_BROWSER;
      throw unsupported;
    }
    throw new Error(detail);
  }
}

async function download(
  request: Extract<Request, { type: "download" }>,
): Promise<void> {
  const { id, url } = request;
  let dispose: (() => Promise<void>) | undefined;
  try {
    const instance = await createRuntime(id);
    dispose = instance.dispose;
    const [file] = await instance.runtime.download(url, {
      format: "bestaudio/best",
      noplaylist: true,
      no_warnings: true,
    }, {
      onProgress: (progress) => {
        const total = progress.type === "download"
          ? progress.totalBytes ?? 0
          : 0;
        const received = progress.type === "download"
          ? progress.downloadedBytes ?? 0
          : 0;
        const percent = total > 0
          ? Math.min(95, Math.round(received * 95 / total))
          : 10;
        postMessage(
          {
            type: "progress",
            id,
            progress: percent,
            stage:
              progress.type === "download" && progress.status === "downloading"
                ? "Downloading audio"
                : "Processing download",
          } satisfies Response,
        );
      },
    });
    if (!file || !("data" in file)) {
      throw new Error("yt-dlp did not produce an audio file.");
    }
    const safeName = sanitizeFileName(file.name);
    const bytes = new Uint8Array(file.data.byteLength);
    bytes.set(file.data);
    postMessage(
      {
        type: "downloaded",
        id,
        name: safeName,
        blob: new Blob([bytes.buffer], { type: file.mimeType || "audio/webm" }),
      } satisfies Response,
    );
  } catch (error) {
    postMessage(
      {
        type: "error",
        id,
        message: !(error instanceof Error)
          ? "Browser-side URL download failed."
          : error.name === UNSUPPORTED_BROWSER
          ? error.message
          : `${error.message} Browser-only URL downloads may not work for YouTube or other sites without CORS.`,
      } satisfies Response,
    );
  } finally {
    if (dispose) await dispose().catch(() => undefined);
  }
}

async function update(
  request: Extract<Request, { type: "update" }>,
): Promise<void> {
  const { id } = request;
  try {
    postMessage(
      {
        type: "progress",
        id,
        progress: 5,
        stage: "Checking yt-dlp releases",
      } satisfies Response,
    );
    const metadataResponse = await fetch("https://pypi.org/pypi/yt-dlp/json");
    if (!metadataResponse.ok) {
      throw new Error(`PyPI update check failed (${metadataResponse.status}).`);
    }
    const metadata = await metadataResponse.json() as PyPiMetadata;
    const version = metadata.info.version;
    if (!version) throw new Error("PyPI did not provide an yt-dlp version.");

    const bundledResponse = await fetch("/yt-dlp/wheel.json");
    const bundled = bundledResponse.ok
      ? await bundledResponse.json() as { wheel: string }
      : { wheel: "" };
    const bundledVersion = bundled.wheel.match(
      /^yt_dlp-(.+)-py3-none-any\.whl$/,
    )?.[1];
    if (
      request.installedVersion === version ||
      (!request.installedVersion && bundledVersion === version)
    ) {
      postMessage({ type: "updated", id, version } satisfies Response);
      return;
    }
    const wheel = metadata.urls.find((item) =>
      item.filename === `yt_dlp-${version}-py3-none-any.whl`
    );
    if (!wheel?.digests.sha256) {
      throw new Error("The latest pure-Python yt-dlp wheel was not found.");
    }
    postMessage(
      {
        type: "progress",
        id,
        progress: 15,
        stage: `Downloading yt-dlp ${version}`,
      } satisfies Response,
    );

    const wheelResponse = await fetch(wheel.url);
    if (!wheelResponse.ok) {
      throw new Error(`Could not download yt-dlp (${wheelResponse.status}).`);
    }
    const blob = await wheelResponse.blob();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await blob.arrayBuffer(),
    );
    const actualDigest = Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (actualDigest !== wheel.digests.sha256.toLowerCase()) {
      throw new Error(
        "The downloaded yt-dlp wheel failed SHA-256 verification.",
      );
    }
    await putModel({
      key: "yt-dlp/current-wheel",
      blob,
      storedAt: Date.now(),
    });
    postMessage({ type: "updated", id, version } satisfies Response);
  } catch (error) {
    postMessage(
      {
        type: "error",
        id,
        message: error instanceof Error
          ? error.message
          : "Could not update yt-dlp.",
      } satisfies Response,
    );
  }
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\.+$/, "").trim().slice(
    0,
    120,
  ) || "audio";
}

interface PyPiMetadata {
  info: { version: string };
  urls: Array<{ filename: string; url: string; digests: { sha256: string } }>;
}
