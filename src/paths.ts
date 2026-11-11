/**
 * URL of a file the build publishes at the site root (models, the yt-dlp
 * runtime, public files). Prefixed with Vite's `base`, so the app also works
 * under a sub-path such as `https://user.github.io/osplit-web/`.
 */
export function appUrl(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\/+/, "");
}
