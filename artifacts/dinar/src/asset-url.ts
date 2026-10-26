export function resolveAssetUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (/^(?:https?:|data:|blob:)/i.test(url)) return url;
  if (url.startsWith("/objects/")) return `/api/storage${url}`;
  const basePath = import.meta.env.BASE_URL.replace(/\/+$/, "");
  const normalizedPath = url.startsWith("/") ? url : `/${url}`;
  if (basePath && (normalizedPath === basePath || normalizedPath.startsWith(`${basePath}/`))) {
    return normalizedPath;
  }
  const base = `${basePath}/`;
  return `${base}${normalizedPath.replace(/^\/+/, "")}`;
}