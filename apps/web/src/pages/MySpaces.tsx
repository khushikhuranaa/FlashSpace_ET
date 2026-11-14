import { useCallback, useEffect, useMemo, useState } from 'react';
import { SPACE_PURPOSES, SPACE_SORTS, SPACE_TEMPLATES } from '@flashspace/shared';
import type { SpaceSort, SpaceTemplate } from '@flashspace/shared';
import { api } from '../api';
import type { AuthUser, Space, SpaceDetail, SpaceStatus, StorageSummary } from '../types';
import { SpaceCard } from '../components/SpaceCard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastProvider';
import { Icon } from '../components/Icon';
import { fmtBytes, fmtDate, fmtDateTime } from '../lib/format';

type Tab = 'all' | 'active' | 'expiring' | 'archived' | 'favorites' | 'shared';

const TABS: [Tab, string][] = [
  ['all', 'All Spaces'],
  ['active', 'Active'],
  ['expiring', 'Expiring'],
  ['archived', 'Archived'],
  ['favorites', 'Favourites'],
  ['shared', 'Shared with me'],
];

const SORTS: [SpaceSort, string][] = [
  ['recent', 'Recently created'],
  ['oldest', 'Oldest created'],
  ['name-asc', 'Name A–Z'],
  ['name-desc', 'Name Z–A'],
  ['expiry', 'Expiry date'],
  ['accessed', 'Recently accessed'],
  ['storage', 'Storage usage'],
];

const PAGE_SIZE = 24;

/** `datetime-local` needs "YYYY-MM-DDTHH:mm", not a full ISO string. */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultDates(): { startAt: string; expiryAt: string } {
  const start = new Date();
  start.setSeconds(0, 0);
  const expiry = new Date(start.getTime() + 7 * 86_400_000);
  return { startAt: toLocalInput(start), expiryAt: toLocalInput(expiry) };
}

export default function MySpaces({
  user,
  navigate,
}: {
  user: AuthUser;
  navigate: (to: string) => void;
}) {
  const toast = useToast().toast;
  const [spaces, setSpaces] = useState<SpaceDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [sort, setSort] = useState<SpaceSort>('recent');
  const [query, setQuery] = useState('');
  const [purposeFilter, setPurposeFilter] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  // Bumped after every mutation so the loader re-runs with fresh state instead
  // of replaying a memoized callback captured before the change.
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ kind: 'archive' | 'delete'; space: SpaceDetail } | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const tabQuery =
        tab === 'archived'
          ? { status: 'ARCHIVED' as SpaceStatus }
          : tab === 'active'
            ? { status: 'ACTIVE' as SpaceStatus }
            : tab === 'expiring'
              ? { status: 'EXPIRING' as const }
              : {};
      const [page, summary] = await Promise.all([
        api.listSpaces({
          ...tabQuery,
          ownership: tab === 'shared' ? 'shared' : 'all',
          favorite: tab === 'favorites' ? true : undefined,
          q: query.trim() || undefined,
          purpose: purposeFilter || undefined,
          sort,
          limit,
          offset: 0,
        }),
        tab === 'all' ? api.storageSummary() : Promise.resolve(storage),
      ]);
      setSpaces(page.spaces);
      setTotal(page.total);
      setStorage(summary);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your Spaces');
    } finally {
      setLoading(false);
    }
    // `storage` is intentionally read but not a dependency: the summary is only
    // refreshed on the all-Spaces tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, sort, query, purposeFilter, limit, version]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  const refresh = async () => {
    setVersion((current) => current + 1);
  };

  const toggleFavorite = async (space: SpaceDetail) => {
    const next = !space.favorite;
    setSpaces((current) => current.map((s) => (s.id === space.id ? { ...s, favorite: next } : s)));
    try {
      if (next) await api.favoriteSpace(space.id);
      else await api.unfavoriteSpace(space.id);
      if (tab === 'favorites' && !next) await refresh();
    } catch (e) {
      setSpaces((current) => current.map((s) => (s.id === space.id ? { ...s, favorite: !next } : s)));
      toast(e instanceof Error ? e.message : 'Could not update favourites', 'error');
    }
  };

  const doArchive = async (space: SpaceDetail) => {
    setBusy(true);
    try {
      await api.archiveSpace(space.id);
      await refresh();
      toast(`"${space.name}" archived`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Archive failed', 'error');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const doDelete = async (space: SpaceDetail) => {
    setBusy(true);
    try {
      await api.deleteSpace(space.id);
      await refresh();
      toast(`"${space.name}" deleted`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const activeBytes = storage ? Math.max(0, storage.usedBytes - storage.archivedBytes) : 0;
  const quota = storage?.quotaBytes ?? 0;
  const archivedBytes = storage?.archivedBytes ?? 0;
  const freeBytes = storage?.freeBytes ?? 0;
  const pct = (value: number) => (quota > 0 ? Math.min(100, (value / quota) * 100) : 0);

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="page-title">My Spaces</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            Every Space you own or collaborate in, with its storage footprint and lifecycle.
          </p>
        </div>
        <button onClick={() => setCreateOpen((open) => !open)} className="btn-primary self-start px-3.5 py-2">
          <Icon name={createOpen ? 'x' : 'plus'} size={16} />
          {createOpen ? 'Close' : 'Create New Space'}
        </button>
      </section>

      {createOpen && (
        <CreateSpacePanel
          timezone={timezone}
          onCancel={() => setCreateOpen(false)}
          onCreated={async (space) => {
            // Stay in the panel so its confirmation card (name, expiry, OWNER
            // role, "Open Space") is shown before navigating anywhere.
            toast(`"${space.name}" created — you are the OWNER`, 'success');
            await refresh();
            void space;
          }}
        />
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}

      {storage && (
        <section className="rounded-xl border border-line bg-white p-4 shadow-xs">
          <div className="mb-3 flex items-center justify-between">
            <span className="flex items-center gap-2 font-display text-[13px] font-bold tracking-tight text-primary">
              <Icon name="hard-drive" size={18} className="text-slate-400" />
              Storage Usage
            </span>
            <span className="font-mono text-[11px] text-muted">
              {Math.round(pct(activeBytes + archivedBytes))}% used
            </span>
          </div>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-flash-600"
              style={{ width: `${pct(activeBytes)}%`, minWidth: activeBytes > 0 ? 4 : 0 }}
            />
            <div
              className="h-full bg-flash-600"
              style={{ width: `${pct(archivedBytes)}%`, minWidth: archivedBytes > 0 ? 4 : 0 }}
            />
            <div className="h-full bg-slate-200" style={{ width: `${pct(freeBytes)}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Legend color="bg-flash-600" label="Space file storage" value={fmtBytes(activeBytes)} />
            <Legend color="bg-flash-600" label="Verified archive storage" value={fmtBytes(archivedBytes)} />
            <Legend color="bg-slate-200" label="Free / available" value={fmtBytes(freeBytes)} />
          </div>
          <p className="mt-3 border-t border-line pt-3 text-[11px] text-muted">
            {fmtBytes(activeBytes + archivedBytes)} of {fmtBytes(quota)} allocated across your Spaces.
          </p>
        </section>
      )}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => {
                setTab(value);
                setLimit(PAGE_SIZE);
              }}
              aria-pressed={tab === value}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
                tab === value
                  ? 'bg-flash-600 text-white shadow-xs'
                  : 'border border-line bg-white text-muted hover:text-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="relative flex-1">
            <span className="sr-only">Search Spaces</span>
            <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="input pl-9"
              placeholder="Search by name, purpose or description"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(PAGE_SIZE);
              }}
            />
          </label>
          <select
            className="input sm:w-48"
            aria-label="Filter by purpose"
            value={purposeFilter}
            onChange={(event) => {
              setPurposeFilter(event.target.value);
              setLimit(PAGE_SIZE);
            }}
          >
            <option value="">All purposes</option>
            {SPACE_PURPOSES.map((purpose) => (
              <option key={purpose} value={purpose}>
                {purpose}
              </option>
            ))}
          </select>
          <select
            className="input sm:w-48"
            aria-label="Sort Spaces"
            value={sort}
            onChange={(event) => setSort(event.target.value as SpaceSort)}
          >
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {loading && spaces.length === 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {[0, 1, 2, 3].map((key) => (
              <div key={key} className="skeleton h-48 rounded-xl" />
            ))}
          </div>
        ) : spaces.length > 0 ? (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {spaces.map((space) => (
                <SpaceCard
                  key={space.id}
                  space={space}
                  onOpen={() => navigate(`/spaces/${space.id}`)}
                  canManage={space.ownerId === user.id}
                  onToggleFavorite={() => void toggleFavorite(space)}
                  onArchive={
                    space.ownerId === user.id && space.status !== 'ARCHIVED' && space.status !== 'ARCHIVING'
                      ? () => setPending({ kind: 'archive', space })
                      : undefined
                  }
                  onDelete={() => setPending({ kind: 'delete', space })}
                />
              ))}
            </div>
            {spaces.length < total && (
              <div className="flex justify-center">
                <button
                  className="btn-secondary px-4 py-2"
                  disabled={loading}
                  onClick={() => setLimit((current) => current + PAGE_SIZE)}
                >
                  {loading ? 'Loading…' : `Load more (${total - spaces.length} remaining)`}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
            <Icon name={tab === 'favorites' ? 'star' : tab === 'archived' ? 'archive' : 'layers'} size={40} className="mx-auto text-slate-300" />
            <p className="mt-3 text-[14px] font-medium text-primary">{emptyTitle(tab, query, purposeFilter)}</p>
            <p className="mt-1 text-[12px] text-muted">{emptyHint(tab)}</p>
            {tab !== 'shared' && tab !== 'archived' && (
              <button onClick={() => setCreateOpen(true)} className="btn-primary mt-4 px-3.5 py-2">
                <Icon name="plus" size={15} />
                Create a Space
              </button>
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'delete' ? 'Delete this Space?' : 'Archive this Space?'}
        message={
          pending?.kind === 'delete'
            ? `"${pending.space.name}" will be removed from every listing. This cannot be undone.`
            : pending
              ? `"${pending.space.name}" will be packaged into your Vault and its live storage released.`
              : ''
        }
        confirmLabel={pending?.kind === 'delete' ? 'Delete permanently' : 'Archive Space'}
        tone={pending?.kind === 'delete' ? 'danger' : 'primary'}
        busy={busy}
        onConfirm={() => {
          if (!pending) return;
          void (pending.kind === 'delete' ? doDelete(pending.space) : doArchive(pending.space));
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function emptyTitle(tab: Tab, query: string, purpose: string): string {
  if (query.trim()) return 'No Spaces match your search';
  if (purpose) return 'No Spaces with that purpose';
  switch (tab) {
    case 'archived':
      return 'Nothing archived yet';
    case 'favorites':
      return 'No favourites yet';
    case 'shared':
      return 'Nothing shared with you yet';
    case 'expiring':
      return 'Nothing is expiring soon';
    default:
      return 'No Spaces here yet';
  }
}

function emptyHint(tab: Tab): string {
  switch (tab) {
    case 'archived':
      return 'Archived Spaces keep their verified ZIP in the Vault and stay downloadable.';
    case 'favorites':
      return 'Star a Space with the star icon to keep it within reach.';
    case 'shared':
      return 'When an owner invites you, their Space appears here with your role.';
    case 'expiring':
      return 'Spaces inside the warning window show up here with their countdown.';
    default:
      return 'Create one from a template and set its start and end time.';
  }
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${color}`} />
      <div>
        <p className="text-[11px] leading-tight text-muted">{label}</p>
        <p className="text-[13px] font-semibold leading-tight text-primary">{value}</p>
      </div>
    </div>
  );
}

/**
 * Create flow: template picker + validated form. The template only prefills the
 * inputs — the request always goes through the normal creation endpoint, so the
 * backend (not the browser) assigns the OWNER role.
 */
function CreateSpacePanel({
  timezone,
  onCancel,
  onCreated,
}: {
  timezone: string;
  onCancel: () => void;
  onCreated: (space: Space) => void;
}) {
  const toast = useToast().toast;
  const initial = useMemo(defaultDates, []);
  const [templateId, setTemplateId] = useState<string>('blank');
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState<string>('Temporary Team Workspace');
  const [customPurpose, setCustomPurpose] = useState('');
  const [description, setDescription] = useState('');
  const [startAt, setStartAt] = useState(initial.startAt);
  const [expiryAt, setExpiryAt] = useState(initial.expiryAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Space | null>(null);

  const chooseTemplate = (template: SpaceTemplate) => {
    setTemplateId(template.id);
    if (!name.trim() || SPACE_TEMPLATES.some((t) => t.name === name)) setName(template.name === 'Blank Space' ? '' : template.name);
    setPurpose(template.purpose);
    setDescription(template.description);
  };

  const finalPurpose = purpose === 'Other' ? customPurpose.trim() : purpose;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (name.trim().length < 3) {
      setError('Space name must be at least 3 characters');
      return;
    }
    if (!finalPurpose) {
      setError('Choose a purpose or write a custom one');
      return;
    }
    const start = new Date(startAt);
    const expiry = new Date(expiryAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(expiry.getTime())) {
      setError('Enter a valid start and end time');
      return;
    }
    if (expiry <= start) {
      setError('The end time must be after the start time');
      return;
    }
    setBusy(true);
    try {
      const result = await api.createSpace({
        name: name.trim(),
        purpose: finalPurpose,
        description: description.trim(),
        startAt: start.toISOString(),
        expiryAt: expiry.toISOString(),
        templateId,
      });
      setCreated(result.space);
      toast(`"${result.space.name}" created — you are the OWNER`, 'success');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not create the Space';
      setError(message);
      toast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <section className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-5 shadow-xs">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <Icon name="check" size={18} />
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-[15px] font-bold tracking-tight text-primary">
              Space created
            </h2>
            <p className="mt-1 text-[13px] text-slate-600">
              <span className="font-semibold text-primary">{created.name}</span> · {created.purpose}
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Expires</p>
                <p className="font-medium text-primary">{fmtDateTime(created.expiryAt)}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Your role</p>
                <p className="font-medium text-primary">OWNER</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Status</p>
                <p className="font-medium text-primary">{created.status}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-primary px-3.5 py-2" onClick={() => onCreated(created)}>
                <Icon name="external-link" size={15} />
                Open Space
              </button>
              <button className="btn-secondary px-3.5 py-2" onClick={() => setCreated(null)}>
                Create another
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-white p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[15px] font-bold tracking-tight text-primary">Create a Space</h2>
          <p className="mt-1 text-[12px] text-muted">
            Pick a template to prefill the folders, then adjust anything before creating.
          </p>
        </div>
        <button type="button" onClick={onCancel} aria-label="Close" className="text-muted hover:text-primary">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SPACE_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => chooseTemplate(template)}
            aria-pressed={templateId === template.id}
            className={`rounded-lg border px-3 py-2 text-left transition-colors ${
              templateId === template.id
                ? 'border-flash-500 bg-flash-50'
                : 'border-line bg-white hover:border-slate-300'
            }`}
          >
            <span className="block text-[12px] font-semibold text-primary">{template.name}</span>
            <span className="mt-0.5 block text-[11px] text-muted">
              {template.folders.length > 0 ? `${template.folders.length} folders` : 'No folders'}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Space name</span>
          <input
            className="input"
            required
            minLength={3}
            maxLength={120}
            value={name}
            placeholder="Q4 Launch Squad"
            onChange={(event) => setName(event.target.value)}
          />
          <span className="mt-1 block text-[11px] text-muted">{name.trim().length}/120</span>
        </label>
        <label className="block">
          <span className="field-label">Purpose</span>
          <select className="input" value={purpose} onChange={(event) => setPurpose(event.target.value)}>
            {SPACE_PURPOSES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {purpose === 'Other' && (
          <label className="block sm:col-span-2">
            <span className="field-label">Custom purpose</span>
            <input
              className="input"
              maxLength={60}
              value={customPurpose}
              placeholder="Describe what this Space is for"
              onChange={(event) => setCustomPurpose(event.target.value)}
            />
          </label>
        )}
        <label className="block sm:col-span-2">
          <span className="field-label">Description</span>
          <textarea
            className="input resize-none"
            rows={3}
            maxLength={2000}
            value={description}
            placeholder="What is this Space for, and who is joining?"
            onChange={(event) => setDescription(event.target.value)}
          />
          <span className="mt-1 block text-[11px] text-muted">{description.length}/2000</span>
        </label>
        <label className="block">
          <span className="field-label">Starts</span>
          <input
            className="input"
            type="datetime-local"
            required
            value={startAt}
            onChange={(event) => setStartAt(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Expires</span>
          <input
            className="input"
            type="datetime-local"
            required
            value={expiryAt}
            onChange={(event) => setExpiryAt(event.target.value)}
          />
        </label>
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted">
        <Icon name="clock" size={13} />
        Times use your timezone ({timezone}) and are stored as UTC timestamps.
      </p>
      {new Date(expiryAt).getTime() <= new Date(startAt).getTime() && (
        <p className="mt-2 text-[11px] text-red-600">The end time must be after the start time.</p>
      )}

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted">
          You are assigned OWNER automatically. {startAt && `Created ${fmtDate(new Date(startAt).toISOString())}.`}
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary px-3.5 py-2" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary px-3.5 py-2" disabled={busy}>
            {busy ? 'Creating…' : 'Create Space'}
          </button>
        </div>
      </div>
    </form>
  );
}
