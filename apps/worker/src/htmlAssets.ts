export function escapeShareHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export function fetchUnconditionalAsset(request: Request, assets: Fetcher, path: string) {
  const headers = new Headers(request.headers);
  for (const name of ["If-None-Match", "If-Modified-Since", "If-Range", "Range"])
    headers.delete(name);
  return assets.fetch(new Request(new URL(path, request.url), { headers }));
}

export function dynamicAssetHeaders(asset: Response): Headers {
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "no-store");
  for (const name of ["ETag", "Last-Modified", "Content-Length", "Content-Encoding"])
    headers.delete(name);
  return headers;
}
