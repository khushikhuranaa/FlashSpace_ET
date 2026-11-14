import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { SearchCategory, SearchResultItem, SearchResults, SpaceDetail } from '../types';
import { Icon } from './Icon';
import { fmtBytes } from '../lib/format';

/**
 * Global search (Module 2.3).
 *
 * Debounced, cancellable, and filtered on the server: the query goes to
 * `/search`, which scopes results to the Spaces the caller belongs to. The
 * browser never receives rows from Spaces the user cannot open, so there is no
 * client-side filtering to bypass.
 */

const CATEGORIES: { value: SearchCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'spaces', label: 'Spaces' },
  { value: 'files', label: 'Files' },
  { value: 'folders', label: 'Folders' },
];

const MIN_QUERY = 2;

export function GlobalSearch({
  open,
  onClose,
  navigate,
}: {
  open: boolean;
  onClose: () => void;
  navigate: (to: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SearchCategory>('all');
  const [spaceId, setSpaceId] = useState('');
  const [spaces, setSpaces] = useState<SpaceDetail[]>([]);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);

  // Spaces for the filter come from the caller's own authorized list.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .listSpaces()
      .then((data) => {
        if (!cancelled) setSpaces(data.spaces);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open]);

  const trimmed = query.trim();

  useEffect(() => {
    if (!open) return;
    if (trimmed.length < MIN_QUERY) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    // Debounce: no request per keystroke, and a stale response never overwrites
    // a newer one (each request carries a sequence number).
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      const seq = ++requestSeq.current;
      api
        .search({ q: trimmed, category, spaceId: spaceId || undefined })
        .then((data) => {
          if (seq !== requestSeq.current) return;
          setResults(data);
          setActiveIndex(0);
        })
        .catch((e) => {
          if (seq !== requestSeq.current) return;
          setResults(null);
          setError(e instanceof Error ? e.message : 'Search failed');
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [open, trimmed, category, spaceId]);

  const close = useCallback(() => {
    setQuery('');
    setResults(null);
    setError(null);
    setSpaceId('');
    setCategory('all');
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  const groups = useMemo(() => {
    if (!results) return [] as { label: string; items: SearchResultItem[] }[];
    return [
      { label: 'Spaces', items: results.spaces },
      { label: 'Files', items: results.files },
      { label: 'Folders', items: results.folders },
    ].filter((group) => group.items.length > 0);
  }, [results]);

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  const openResult = useCallback(
    (item: SearchResultItem) => {
      if (item.type === 'space') navigate(`/spaces/${item.id}`);
      else navigate(`/spaces/${item.spaceId}/files`);
      close();
    },
    [navigate, close],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length));
    } else if (event.key === 'Enter') {
      const item = flat[activeIndex];
      if (item) {
        event.preventDefault();
        openResult(item);
      }
    }
  };

  if (!open) return null;

  const total = results ? results.totals.spaces + results.totals.files + results.totals.folders : 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-slate-900/40 p-4 pt-[10vh] backdrop-blur-sm sm:pt-[14vh]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search FlashSpace"
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <Icon name="search" size={18} className="flex-shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Spaces, files and folders…"
            aria-label="Search query"
            className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-primary placeholder:text-slate-400 focus:outline-none"
          />
          {query && (
            <button
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-primary"
            >
              <Icon name="x" size={15} />
            </button>
          )}
          <button onClick={close} className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 hover:bg-slate-50">
            Esc
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/60 px-3 py-2">
          <div className="inline-flex rounded-md bg-white p-0.5 ring-1 ring-slate-200">
            {CATEGORIES.map((option) => (
              <button
                key={option.value}
                onClick={() => setCategory(option.value)}
                aria-pressed={category === option.value}
                className={`rounded px-2 py-1 text-[12px] transition-colors ${
                  category === option.value
                    ? 'bg-slate-100 font-semibold text-primary'
                    : 'text-muted hover:text-primary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <select
            value={spaceId}
            onChange={(e) => setSpaceId(e.target.value)}
            aria-label="Filter by Space"
            className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-primary focus:border-flash-500 focus:outline-none"
          >
            <option value="">All my Spaces</option>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
          </select>
        </div>

        <div className="max-h-[52vh] overflow-y-auto">
          {trimmed.length < MIN_QUERY && (
            <div className="px-4 py-8 text-center">
              <Icon name="search" size={26} className="mx-auto text-slate-300" />
              <p className="mt-2 text-[13px] text-muted">
                Type at least {MIN_QUERY} characters to search your authorized Spaces.
              </p>
            </div>
          )}

          {trimmed.length >= MIN_QUERY && loading && !results && (
            <div className="space-y-2 px-3 py-3" aria-label="Searching">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="skeleton h-10 w-full rounded-lg" />
              ))}
            </div>
          )}

          {error && (
            <div className="px-4 py-6 text-center">
              <p className="text-[13px] text-red-700">{error}</p>
              <button
                onClick={() => setQuery((q) => `${q} `.trim())}
                className="btn-secondary mt-3 px-3 py-1.5 text-[12px]"
              >
                Try again
              </button>
            </div>
          )}

          {!error && results && total === 0 && (
            <div className="px-4 py-8 text-center">
              <Icon name="inbox" size={26} className="mx-auto text-slate-300" />
              <p className="mt-2 text-[13px] font-medium text-primary">No matches for “{results.query}”</p>
              <p className="mt-1 text-[12px] text-muted">
                Search only covers Spaces, files and folders you can access.
              </p>
            </div>
          )}

          {!error &&
            groups.map((group) => (
              <div key={group.label} className="py-1">
                <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  {group.label}
                </p>
                {group.items.map((item) => {
                  const index = flat.indexOf(item);
                  const active = index === activeIndex;
                  return (
                    <button
                      key={`${item.type}-${item.id}`}
                      onClick={() => openResult(item)}
                      onMouseEnter={() => setActiveIndex(index)}
                      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
                        active ? 'bg-flash-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                        <Icon
                          name={item.type === 'space' ? 'layers' : item.type === 'folder' ? 'folder' : 'file'}
                          size={15}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-primary">{item.name}</span>
                        <span className="block truncate text-[11px] text-muted">
                          {item.type === 'space' ? item.detail : `${item.spaceName} · ${item.detail ?? ''}`}
                        </span>
                      </span>
                      <span className="flex-shrink-0 font-mono text-[10px] uppercase text-slate-400">
                        {item.type === 'space'
                          ? (item.status ?? '')
                          : item.sizeBytes !== null
                            ? fmtBytes(item.sizeBytes)
                            : 'folder'}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/60 px-4 py-2 text-[11px] text-muted">
          <span className="flex items-center gap-2">
            <kbd className="rounded border border-slate-200 bg-white px-1 font-mono text-[10px]">↑</kbd>
            <kbd className="rounded border border-slate-200 bg-white px-1 font-mono text-[10px]">↓</kbd>
            to move,
            <kbd className="rounded border border-slate-200 bg-white px-1 font-mono text-[10px]">↵</kbd>
            to open
          </span>
          {results && (
            <span>
              {total} {total === 1 ? 'result' : 'results'}
              {results.truncated ? '+' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
