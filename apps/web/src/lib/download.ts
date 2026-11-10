/**
 * Start a download from a signed URL.
 *
 * Assigning `window.location.href` would replace the running app when the
 * response is not treated as an attachment. A temporary anchor keeps the user
 * on the current page; the signed URL still enforces access on the server.
 */
export function triggerDownload(url: string, filename?: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  if (filename) anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
