import { Icon, type IconName } from '../components/Icon';

const HIGHLIGHTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'clock',
    title: 'Countdown to zero',
    body: 'Every Space carries a start and an end. The interface always shows exactly how much time is left before it is sealed.',
  },
  {
    icon: 'archive',
    title: 'Automatic ZIP snapshots',
    body: 'When a Space reaches its end, its folder tree is packaged into a verified archive and the live storage is reclaimed.',
  },
  {
    icon: 'shield',
    title: 'A Vault you control',
    body: 'Archives stay downloadable by the people who owned them. Nothing is orphaned, nothing lingers without an owner.',
  },
];

const STEPS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'plus',
    title: 'Create a Space',
    body: 'Name the work, set the purpose and choose when it should end. Invite collaborators with a role.',
  },
  {
    icon: 'upload',
    title: 'Collaborate',
    body: 'Upload files into folders, review storage insights and extend the deadline when the team needs more time.',
  },
  {
    icon: 'archive',
    title: 'Let it close',
    body: 'The lifecycle runner archives the Space on schedule, verifies the ZIP, then releases the ephemeral storage.',
  },
];

export default function Landing({ onEnter }: { onEnter: () => void }) {
  const scrollTo = (id: string) => () => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="min-h-screen bg-surface">
      <nav className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/75 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="font-display text-xl font-bold tracking-tight text-primary">FlashSpace</span>
          </div>
          <div className="hidden items-center gap-8 text-sm font-medium text-muted md:flex">
            <button onClick={scrollTo('highlights')} className="transition-colors hover:text-primary">
              Overview
            </button>
            <button onClick={scrollTo('how')} className="transition-colors hover:text-primary">
              How it works
            </button>
            <button onClick={scrollTo('principles')} className="transition-colors hover:text-primary">
              Principles
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onEnter}
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-primary"
            >
              Sign in
            </button>
            <button
              onClick={onEnter}
              className="inline-flex items-center justify-center rounded-lg bg-flash-600 px-4 py-2 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-flash-700"
            >
              Launch FlashSpace
            </button>
          </div>
        </div>
      </nav>

      <main className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute left-1/2 top-0 h-[520px] w-[720px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-flash-100/60 via-purple-100/30 to-blue-50/50 blur-3xl" />
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#6366f108_1px,transparent_1px),linear-gradient(to_bottom,#6366f108_1px,transparent_1px)] bg-[size:48px_48px]" />
        </div>

        <section className="relative z-10 mx-auto flex max-w-4xl flex-col items-center px-6 pb-16 pt-20 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-flash-200/70 bg-flash-50/80 px-3 py-1 text-xs font-medium text-flash-700">
            Autonomous cloud workspaces
          </span>
          <h1 className="mt-6 font-display text-4xl font-bold leading-[1.12] tracking-tight text-primary sm:text-5xl md:text-6xl">
            Temporary cloud storage that cleans up after itself.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
            Collaborate on hackathons and sprints with automatic TTL countdowns, verified ZIP
            snapshots, and zero orphaned storage.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={onEnter}
              className="inline-flex items-center gap-2 rounded-lg bg-flash-600 px-5 py-2.5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-flash-700"
            >
              Launch FlashSpace
              <Icon name="chevron-right" size={16} />
            </button>
            <button
              onClick={onEnter}
              className="inline-flex items-center rounded-lg border border-slate-200/90 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Sign in
            </button>
          </div>

          <div className="mt-12 w-full max-w-xl rounded-xl border border-slate-200/80 bg-white/80 p-5 text-left shadow-xs backdrop-blur-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
                Lifecycle
              </span>
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                Scheduled
              </span>
            </div>
            <div className="mt-4 flex items-center gap-2 font-mono text-[12px] text-muted">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-flash-50 text-flash-700">
                <Icon name="layers" size={14} />
              </span>
              Space created
              <span className="mx-1 h-px flex-1 bg-slate-200" />
              <Icon name="clock" size={14} className="text-amber-500" />
              <span className="text-amber-600">TTL running</span>
              <span className="mx-1 h-px flex-1 bg-slate-200" />
              <Icon name="archive" size={14} className="text-flash-600" />
              <span className="text-flash-700">ZIP verified</span>
            </div>
            <p className="mt-4 border-t border-slate-100 pt-3 text-[12px] leading-relaxed text-muted">
              The lifecycle runner checks every Space on a schedule: warnings first, then archive,
              verification and storage release.
            </p>
          </div>
        </section>

        <section id="highlights" className="relative z-10 mx-auto max-w-6xl scroll-mt-20 px-6 pb-16">
          <div className="grid gap-4 md:grid-cols-3">
            {HIGHLIGHTS.map((item) => (
              <div key={item.title} className="rounded-xl border border-line bg-white p-6 shadow-xs">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-flash-50 text-flash-700">
                  <Icon name={item.icon} size={20} />
                </span>
                <h2 className="mt-4 font-display text-[15px] font-bold text-primary">{item.title}</h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="relative z-10 border-y border-slate-200/70 bg-white/60">
          <div className="mx-auto max-w-6xl scroll-mt-20 px-6 py-16">
            <h2 className="font-display text-2xl font-bold tracking-tight text-primary">
              Three steps, one guaranteed ending.
            </h2>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
              FlashSpace keeps the lifecycle explicit. Nothing depends on someone remembering to
              clean up later.
            </p>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <div key={step.title} className="rounded-xl border border-line bg-white p-6 shadow-xs">
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-flash-600 font-mono text-[12px] font-semibold text-white">
                      {index + 1}
                    </span>
                    <Icon name={step.icon} size={18} className="text-flash-600" />
                  </div>
                  <h3 className="mt-4 text-[14px] font-semibold text-primary">{step.title}</h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="principles" className="relative z-10 mx-auto max-w-6xl scroll-mt-20 px-6 py-16">
          <div className="grid gap-8 md:grid-cols-2">
            <div>
              <h2 className="font-display text-2xl font-bold tracking-tight text-primary">
                Built for work with a deadline.
              </h2>
              <p className="mt-3 text-[13px] leading-relaxed text-muted">
                Hackathons, sprints, client hand-offs and one-off experiments all end. FlashSpace
                treats that ending as a first-class part of the product instead of an afterthought.
              </p>
            </div>
            <ul className="space-y-3">
              {[
                'Scoped access: owner, editor and viewer roles enforced by the API.',
                'Storage insights that surface duplicates before they cost you space.',
                'Activity records and notifications for every lifecycle decision.',
                'Archives verified by file count before they are offered for download.',
              ].map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-[13px] text-slate-700">
                  <Icon name="check" size={16} className="mt-0.5 shrink-0 text-emerald-600" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200/60 bg-white/40 px-6 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <div className="flex items-center gap-2 font-medium">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span>All systems operational</span>
          </div>
          <span className="text-slate-400">2026 FlashSpace Cloud Technologies</span>
        </div>
      </footer>
    </div>
  );
}
