import type {
  AuthUser,
  FileRecord,
  SearchCategory,
  SearchResultItem,
  SearchResults,
  SpaceDetail,
} from '@flashspace/shared';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { SpacesService } from './spaces.service.js';

export interface SearchParams {
  q: string;
  category?: SearchCategory;
  spaceId?: string;
  /** MIME prefix or exact type, e.g. `image/` or `application/pdf`. */
  fileType?: string;
  limit?: number;
}

const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

/**
 * Global search (Module 2.3).
 *
 * Authorization is the first step, not a filter applied afterwards: the search
 * space is built from `spaces.listForUser`, so Spaces the caller cannot access
 * are never read, and files/folders are only taken from those Spaces. Object
 * keys and signed URLs are never part of a result payload.
 */
export class SearchService {
  constructor(
    private readonly db: DataLayer,
    private readonly spaces: SpacesService,
  ) {}

  async search(actor: AuthUser, params: SearchParams): Promise<SearchResults> {
    const query = normalize(params.q);
    const category: SearchCategory = params.category ?? 'all';
    const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const empty: SearchResults = {
      query,
      category,
      spaces: [],
      files: [],
      folders: [],
      totals: { spaces: 0, files: 0, folders: 0 },
      truncated: false,
      minQueryLength: MIN_QUERY_LENGTH,
    };
    if (query.length < MIN_QUERY_LENGTH) return empty;

    const accessible = await this.spaces.listForUser(actor.id);
    // A Space filter can only narrow the authorized set — never widen it.
    const scoped = params.spaceId
      ? accessible.filter((space) => space.id === params.spaceId)
      : accessible;
    if (scoped.length === 0) return empty;

    const wantSpaces = category === 'all' || category === 'spaces';
    const wantFiles = category === 'all' || category === 'files';
    const wantFolders = category === 'all' || category === 'folders';

    const spaceMatches = wantSpaces ? scoped.filter((space) => matchesSpace(space, query)) : [];
    const files = wantFiles ? await this.filesIn(scoped, query, params.fileType) : [];
    const folders = wantFolders ? await this.foldersIn(scoped, query) : [];

    const totalOf = (items: unknown[]) => items.length;
    return {
      query,
      category,
      spaces: spaceMatches.slice(0, limit).map(toSpaceResult),
      files: files.slice(0, limit).map(toFileResult),
      folders: folders.slice(0, limit).map(toFolderResult),
      totals: { spaces: totalOf(spaceMatches), files: totalOf(files), folders: totalOf(folders) },
      truncated:
        spaceMatches.length > limit || files.length > limit || folders.length > limit,
      minQueryLength: MIN_QUERY_LENGTH,
    };
  }

  private async filesIn(
    spaces: SpaceDetail[],
    query: string,
    fileType?: string,
  ): Promise<{ file: FileRecord; space: SpaceDetail }[]> {
    const out: { file: FileRecord; space: SpaceDetail }[] = [];
    for (const space of spaces) {
      const rows = await this.db.files.listActiveForSpace(space.id);
      for (const file of rows) {
        if (fileType && !file.mimeType.toLowerCase().startsWith(fileType.toLowerCase())) continue;
        if (normalize(file.name).includes(query)) out.push({ file, space });
      }
    }
    return out.sort((a, b) => b.file.createdAt.localeCompare(a.file.createdAt));
  }

  private async foldersIn(spaces: SpaceDetail[], query: string) {
    const out: { folder: { id: string; spaceId: string; parentId: string | null; name: string; path: string; updatedAt: string }; space: SpaceDetail }[] = [];
    for (const space of spaces) {
      const rows = await this.db.folders.listForSpace(space.id);
      for (const folder of rows) {
        if (normalize(folder.name).includes(query) || normalize(folder.path).includes(query)) {
          out.push({ folder, space });
        }
      }
    }
    return out.sort((a, b) => a.folder.path.localeCompare(b.folder.path));
  }
}

/** Case-insensitive, whitespace-normalized comparison key. */
function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchesSpace(space: SpaceDetail, query: string): boolean {
  return (
    normalize(space.name).includes(query) ||
    normalize(space.purpose).includes(query) ||
    normalize(space.description ?? '').includes(query)
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function toSpaceResult(space: SpaceDetail): SearchResultItem {
  return {
    id: space.id,
    type: 'space',
    name: space.name,
    spaceId: space.id,
    spaceName: space.name,
    detail: space.purpose,
    sizeBytes: space.storageUsedBytes,
    status: space.status,
    updatedAt: space.updatedAt,
    folderId: null,
  };
}

function toFileResult(entry: { file: FileRecord; space: SpaceDetail }): SearchResultItem {
  return {
    id: entry.file.id,
    type: 'file',
    name: entry.file.name,
    spaceId: entry.space.id,
    spaceName: entry.space.name,
    detail: entry.file.mimeType,
    sizeBytes: entry.file.sizeBytes,
    status: entry.file.status,
    updatedAt: entry.file.createdAt,
    folderId: entry.file.folderId,
  };
}

function toFolderResult(entry: {
  folder: { id: string; spaceId: string; parentId: string | null; name: string; path: string; updatedAt: string };
  space: SpaceDetail;
}): SearchResultItem {
  return {
    id: entry.folder.id,
    type: 'folder',
    name: entry.folder.name,
    spaceId: entry.space.id,
    spaceName: entry.space.name,
    detail: entry.folder.path,
    sizeBytes: null,
    status: null,
    updatedAt: entry.folder.updatedAt,
    folderId: entry.folder.id,
  };
}
