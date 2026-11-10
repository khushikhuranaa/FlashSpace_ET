/** Hash routes look like `#/spaces/<id>/files` (page / param / sub). */
export interface Route {
  page: string;
  param?: string;
  sub?: string;
}

export function parseHash(hash: string = window.location.hash): Route {
  // Accept `#/join/token` and the `#!/join/token` links the API generates.
  const parts = hash
    .replace(/^#!?\/?/, '')
    .split('/')
    .filter((part) => part.length > 0);
  return {
    page: parts[0] ?? 'landing',
    param: parts[1],
    sub: parts[2],
  };
}

export function routeHref(page: string, param?: string, sub?: string): string {
  return ['', page, param, sub].filter((part) => part !== undefined && part !== '').join('/');
}
