import type { Folder } from '@flashspace/shared';
import type { FoldersRepo } from '../repositories/data-layer.interface.js';

/**
 * Resolve the folder path of a file inside a Space (PRD §5.3): the archive must
 * preserve the original directory hierarchy, so every consumer (upload, scan,
 * ZIP writer) derives paths the same way.
 *
 * Returns a prefix ending in `/` (`''` at the Space root) so callers can build
 * both storage keys and archive entry names by simple concatenation.
 */
export function folderPathFor(
  folders: FoldersRepo,
  spaceId: string,
  folderId: string | null | undefined,
): string {
  if (!folderId) return '';
  const seen = new Set<string>();
  const parts: string[] = [];
  let current: Folder | undefined = folders.findById(folderId);
  while (current && current.spaceId === spaceId && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = current.parentId ? folders.findById(current.parentId) : undefined;
  }
  return parts.length ? `${parts.join('/')}/` : '';
}

/** Normalise a single path segment (folder or file name) for archive entries. */
export function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[\\/\0]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 180) || 'file';
}

/**
 * Return a unique entry name inside the archive. Two different files with the
 * same name (same folder, or a selective archive) must never collide inside the
 * ZIP, otherwise an extractor would silently drop one of them.
 */
export function uniqueEntryName(directory: string, name: string, used: Set<string>): string {
  const dir = directory
    .split('/')
    .filter(Boolean)
    .map(safeSegment)
    .join('/');
  const base = safeSegment(name);
  const prefix = dir ? `${dir}/` : '';
  let candidate = `${prefix}${base}`;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 2; ; i += 1) {
    candidate = `${prefix}${stem} (${i})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
