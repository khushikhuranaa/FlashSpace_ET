import { useEffect, type ReactNode } from 'react';

/**
 * Public legal pages (Privacy Policy + Terms of Service).
 *
 * Google's OAuth consent-screen verification requires publicly reachable policy
 * URLs, so both pages are plain hash routes that work signed out and on any
 * host. The content describes what FlashSpace actually does — no invented legal
 * entity, address or compliance claim. Placeholders in square brackets are
 * deliberate: the operator must fill them in before verification.
 */

const UPDATED = '[EFFECTIVE DATE]';

function usePageMetadata(title: string, description: string): void {
  useEffect(() => {
    const previousTitle = document.title;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousDescription = meta?.content ?? '';
    document.title = title;
    if (meta) meta.content = description;
    return () => {
      document.title = previousTitle;
      if (meta) meta.content = previousDescription;
    };
  }, [title, description]);
}

function LegalShell({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-surface">
      <header className="border-b border-line bg-white/70">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <a href="#/" className="flex items-center gap-2.5 rounded-lg">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-flash-50" aria-hidden="true">
              <svg
                className="h-4 w-4 text-flash-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M17.5 19a3.5 3.5 0 0 0 5 0H6.5a3.5 3.5 0 0 0 3.5 3.42V7.75a3.5 3.5 0 0 0-2.27-3.27L5 2h14z" />
                <path d="M9.5 11.5 12 14l2.5-2.5" />
              </svg>
            </span>
            <span className="font-display text-lg font-bold tracking-tight text-primary">FlashSpace</span>
          </a>
          <nav aria-label="Public pages" className="flex items-center gap-4 text-[13px]">
            <a href="#/privacy" className="rounded text-muted hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500">
              Privacy
            </a>
            <a href="#/terms" className="rounded text-muted hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500">
              Terms
            </a>
            <a href="#/" className="font-medium text-flash-700 hover:underline">
              Back to home
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-10">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-flash-700">{eyebrow}</p>
        <h1 className="mt-2 font-display text-2xl font-bold text-primary sm:text-3xl">{title}</h1>
        <p className="mt-2 text-[13px] text-muted">Last updated: {UPDATED}</p>
        <p className="mt-5 rounded-xl border border-line bg-white px-4 py-3 text-[13px] leading-relaxed text-secondary">
          {intro}
        </p>
        <div className="mt-8 space-y-8">{children}</div>
      </main>

      <footer className="border-t border-line bg-white/60">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-5 text-xs text-muted">
          <span>FlashSpace</span>
          <div className="flex flex-wrap items-center gap-4">
            <a href="#/privacy" className="hover:text-primary">
              Privacy Policy
            </a>
            <a href="#/terms" className="hover:text-primary">
              Terms of Service
            </a>
            <a href="#/" className="hover:text-primary">
              Home
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-base font-bold text-primary">{title}</h2>
      <div className="mt-2 space-y-3 text-[13px] leading-relaxed text-secondary">{children}</div>
    </section>
  );
}

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

export function PrivacyPolicy() {
  usePageMetadata(
    'Privacy Policy — FlashSpace',
    'How FlashSpace collects, uses, stores and deletes account data, uploaded files and workspace activity.',
  );

  return (
    <LegalShell
      eyebrow="Legal"
      title="Privacy Policy"
      intro="FlashSpace provides temporary, purpose-based workspaces with an expiry date. This policy explains what data the service handles, why, and how you can access or delete it. FlashSpace is operated by [OPERATOR / LEGAL ENTITY] (“we”)."
    >
      <Section title="1. Information we collect">
        <p>We collect only what the product needs to run:</p>
        <List
          items={[
            'Account data: email address, display name, optional profile picture, application role (user or administrator) and account status.',
            'Authentication data: a hashed password in local development mode, or — when Supabase Auth is configured — your Supabase user identifier, sign-in provider, email verification status and session metadata. Passwords are never stored in plain text.',
            'Workspace content: Space names, purposes, descriptions, start and expiry dates, folders, uploaded files (name, type, size, checksum) and generated Vault archives.',
            'Collaboration data: memberships and roles (owner, editor, viewer), invitations, invite links and join requests.',
            'Activity and notifications: records of actions such as uploads, membership changes, lifecycle warnings, archiving and verification, plus in-app notifications.',
            'Technical data needed for security and reliability: IP address and user agent for session records and rate limiting, timestamps, and error diagnostics.',
            'Preferences: notification settings and interface choices you save.',
          ]}
        />
      </Section>

      <Section title="2. Signing in with Google">
        <p>
          Google sign-in is optional and available when the deployment has Supabase Auth with the Google provider
          enabled. When you use it, Google authenticates you and shares basic profile information with Supabase —
          typically your email address, name and profile picture. We never receive your Google password.
        </p>
        <p>
          If the verified Google email matches an existing FlashSpace account, the identity is linked to that account
          so your Spaces and files remain yours. You can keep using email and password sign-in instead.
        </p>
      </Section>

      <Section title="3. How we use data">
        <List
          items={[
            'To create and secure your account, authenticate sessions and enforce roles and permissions.',
            'To store, serve, share and archive workspace content, and to run the lifecycle: expiry warnings, ZIP archiving, archive verification and storage release.',
            'To enforce storage quotas, upload restrictions and rate limits, and to detect abuse.',
            'To show activity history, notifications and administrative tooling to the people authorised to see them.',
            'To diagnose failures and keep the service available.',
          ]}
        />
        <p>We do not sell personal data, and we do not use uploaded file contents for advertising.</p>
      </Section>

      <Section title="4. Storage, retention and deletion">
        <p>
          FlashSpace is built around expiry. Each Space has a start and an end date; when it ends, its files are
          packaged into a verified ZIP archive in the owner&apos;s Vault, memberships are revoked and the live
          workspace storage is released. Archives are retained in the Vault until they are deleted or the owning
          account is removed.
        </p>
        <List
          items={[
            'Live workspace files are removed after archival; temporary archive staging objects are cleaned up by scheduled jobs.',
            'Archived Vault entries remain downloadable by their owner (and administrators) until deleted.',
            'Deleting your account removes your profile and the data you own, subject to records we must retain for security, legal or accounting reasons, and subject to backup rotation.',
            'Session and activity records are kept for security and audit purposes and are pruned according to the deployment’s retention settings.',
          ]}
        />
        <p>
          Because expiry is the core behaviour of the product, treat a Space as temporary storage and keep your own
          copy of anything you cannot afford to lose.
        </p>
      </Section>

      <Section title="5. Who can see your data">
        <List
          items={[
            'Members of a Space can see that Space’s content according to their role (owner, editor, viewer).',
            'Space owners and administrators can see membership, activity and storage information for Spaces they manage.',
            'Platform administrators can access administrative views (accounts, jobs, storage health, audit records) to operate the service.',
            'Service providers process data on our behalf: Supabase (authentication, PostgreSQL database, object storage), Google (only if you choose Google sign-in), our email delivery provider, and our hosting provider.',
          ]}
        />
      </Section>

      <Section title="6. Security">
        <p>
          Passwords are hashed, sessions use short-lived tokens with rotating refresh tokens, private files are served
          through short-lived signed URLs after an authorisation check, database access is scoped by row-level
          security policies, uploads are restricted by size and file extension, and sensitive endpoints are rate
          limited.
        </p>
        <p>
          No service can promise perfect security. If you believe your account or a workspace has been compromised,
          revoke your sessions in Settings and contact us at [CONTACT EMAIL].
        </p>
      </Section>

      <Section title="7. Your choices and rights">
        <List
          items={[
            'Access and export: Settings → “Export your data” downloads a JSON copy of your profile, preferences and personal records.',
            'Correction: update your display name, avatar, email address and notification preferences in Settings.',
            'Deletion: Settings → “Delete account” removes your account, subject to the retention notes above.',
            'Session control: review and revoke active sessions in Settings.',
            'Email: notification preferences control lifecycle and account emails.',
          ]}
        />
        <p>
          Depending on where you live you may have additional rights (for example access, correction, deletion,
          portability or objection). Contact [CONTACT EMAIL] and we will respond as required by applicable law.
        </p>
      </Section>

      <Section title="8. Children">
        <p>
          FlashSpace is a work and collaboration tool and is not intended for children under [MINIMUM AGE]. We do not
          knowingly collect data from children below that age.
        </p>
      </Section>

      <Section title="9. Changes to this policy">
        <p>
          We may update this policy as the product changes. Material changes will be announced in the application, and
          the “Last updated” date above will change.
        </p>
      </Section>

      <Section title="10. Contact">
        <p>
          Questions about this policy or your data: [CONTACT EMAIL]. Operator: [OPERATOR / LEGAL ENTITY], [POSTAL
          ADDRESS].
        </p>
      </Section>
    </LegalShell>
  );
}

export function TermsOfService() {
  usePageMetadata(
    'Terms of Service — FlashSpace',
    'The terms that govern use of FlashSpace temporary workspaces, uploads, collaboration and archive retention.',
  );

  return (
    <LegalShell
      eyebrow="Legal"
      title="Terms of Service"
      intro="These terms govern your use of FlashSpace, a service for temporary, purpose-based workspaces that archive and release storage when a Space expires. By creating an account or using the service you agree to them. The service is provided by [OPERATOR / LEGAL ENTITY] (“we”)."
    >
      <Section title="1. Accounts">
        <List
          items={[
            'You must provide accurate account information and keep your credentials secure.',
            'You are responsible for activity performed through your account and for the people you invite to a Space.',
            'One account per person. Do not share credentials; invite collaborators instead.',
            'We may suspend accounts that are compromised, abusive or used to break these terms.',
          ]}
        />
      </Section>

      <Section title="2. Spaces, expiry and your responsibility to keep copies">
        <p>
          Every Space has an expiry date. When it is reached, FlashSpace archives the Space’s files into a ZIP archive
          in the owner’s Vault, revokes memberships and releases the live storage. This is the intended behaviour of
          the product, not data loss caused by a fault.
        </p>
        <p>
          You are responsible for downloading anything you need before a Space expires. Administrators may also
          archive or delete Spaces to enforce quotas, resolve abuse or comply with the law.
        </p>
      </Section>

      <Section title="3. Acceptable use">
        <List
          items={[
            'Do not upload or share content that is unlawful, infringing, malicious or that you have no right to distribute.',
            'Do not upload malware, executable installers or scripts intended to harm others; such extensions are blocked at upload and files may be scanned.',
            'Do not attempt to bypass roles, quotas, rate limits, signed URLs or storage restrictions, or probe the service for vulnerabilities without permission.',
            'Do not use the service to send spam or to store data you are legally required to keep elsewhere.',
          ]}
        />
      </Section>

      <Section title="4. Collaboration and roles">
        <p>
          Space owners control membership and can invite editors and viewers. Owners are responsible for who they
          invite and for the content in their Spaces. Viewers can read content; editors can modify it; owners manage
          the Space, its members and its lifecycle.
        </p>
      </Section>

      <Section title="5. Storage limits">
        <p>
          Accounts and Spaces have storage and upload limits, and uploads are restricted by size and file type.
          Limits may change as the service evolves; current values are shown in the application and enforced by the
          API.
        </p>
      </Section>

      <Section title="6. Your content">
        <p>
          You keep ownership of the content you upload. You grant us the limited licence needed to store, copy,
          transmit, archive and delete it as part of operating the service — for example creating Vault archives and
          serving signed download links to authorised members.
        </p>
      </Section>

      <Section title="7. Third-party services">
        <p>
          The service relies on third parties such as Supabase (authentication, database, object storage), Google (only
          if you choose Google sign-in), an email delivery provider and a hosting provider. Their availability and
          terms also affect the service.
        </p>
      </Section>

      <Section title="8. Availability and changes">
        <p>
          We work to keep FlashSpace available, but it is provided without an uptime guarantee. Features may change,
          and scheduled jobs (warnings, archiving, cleanup) may run with some delay. We may suspend the service for
          maintenance.
        </p>
      </Section>

      <Section title="9. Termination">
        <p>
          You may stop using the service and delete your account at any time in Settings. We may suspend or terminate
          access for material breaches of these terms, unlawful use, or to protect the service and its users.
        </p>
      </Section>

      <Section title="10. Disclaimers and liability">
        <p>
          To the extent permitted by applicable law, the service is provided “as is” and without warranties of
          merchantability, fitness for a particular purpose or non-infringement. We are not liable for indirect or
          consequential losses, or for loss of data you did not keep a copy of.
        </p>
        <p>
          Nothing in these terms excludes liability that cannot lawfully be excluded. Any liability cap, governing law
          and dispute venue must be completed by the operator: [GOVERNING LAW / JURISDICTION].
        </p>
      </Section>

      <Section title="11. Contact">
        <p>Questions about these terms: [CONTACT EMAIL]. Operator: [OPERATOR / LEGAL ENTITY], [POSTAL ADDRESS].</p>
      </Section>
    </LegalShell>
  );
}
