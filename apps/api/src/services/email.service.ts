/**
 * Email service — transactional email delivery for FlashSpace.
 *
 * Uses a provider-agnostic `Transport` interface so the app can run with real
 * SMTP (via `nodemailer`) or in a local-development/mock mode where emails are
 * logged but never delivered. Each message is recorded as an `EmailJobRow` in
 * the data layer before it is handed to the transport, which gives us audit,
 * retry and admin visibility without coupling the rest of the app to any
 * particular provider.
 */

import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { EmailJobRow } from '../repositories/data-layer.interface.js';
import type { MemberRole } from '@flashspace/shared';
import { VerificationTokensService } from './verification-tokens.service.js';

export { VerificationTokensService };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'RETRY_SCHEDULED';

export type EmailCategory =
  | 'VERIFICATION'
  | 'SECURITY'
  | 'INVITATIONS'
  | 'JOIN_REQUESTS'
  | 'SPACE_LIFECYCLE'
  | 'ARCHIVES'
  | 'EXTENSIONS'
  | 'MEMBERSHIP'
  | 'SYSTEM';

export type EmailTemplate =
  | 'email-verification'
  | 'password-reset'
  | 'space-invitation'
  | 'join-request-received'
  | 'join-request-approved'
  | 'join-request-declined'
  | 'space-expiry-warning'
  | 'test'
  | 'archive-completed'
  | 'archive-failed'
  | 'extension-approved'
  | 'extension-rejected'
  | 'member-role-changed'
  | 'member-removed';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EmailConfig {
  transport: 'smtp' | 'mock';
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  smtpSecure?: boolean;
  smtpTlsServername?: string;
  fromEmail: string;
  fromName: string;
  connectionTimeoutMs: number;
  deliveryTimeoutMs: number;
  verificationExpiryMs: number;
  resetExpiryMs: number;
  invitationExpiryMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  adminTestRecipient?: string;
}

const DEFAULTS: Omit<EmailConfig, 'transport'> = {
  fromEmail: 'flashspace@flashspace.local',
  fromName: 'FlashSpace',
  connectionTimeoutMs: 10_000,
  deliveryTimeoutMs: 30_000,
  verificationExpiryMs: 24 * 60 * 60 * 1000,
  resetExpiryMs: 60 * 60 * 1000,
  invitationExpiryMs: 7 * 24 * 60 * 60 * 1000,
  maxRetries: 3,
  retryBaseDelayMs: 5_000,
  retryMaxDelayMs: 300_000,
};

function resolveConfig(user?: Partial<EmailConfig>): EmailConfig {
  if (user?.transport === 'smtp') {
    return {
      transport: 'smtp',
      smtpHost: user.smtpHost ?? '',
      smtpPort: user.smtpPort ?? 587,
      smtpUser: user.smtpUser ?? '',
      smtpPassword: user.smtpPassword ?? '',
      smtpSecure: user.smtpSecure ?? false,
      smtpTlsServername: user.smtpTlsServername,
      fromEmail: user.fromEmail ?? DEFAULTS.fromEmail,
      fromName: user.fromName ?? DEFAULTS.fromName,
      connectionTimeoutMs: user.connectionTimeoutMs ?? DEFAULTS.connectionTimeoutMs,
      deliveryTimeoutMs: user.deliveryTimeoutMs ?? DEFAULTS.deliveryTimeoutMs,
      verificationExpiryMs: user.verificationExpiryMs ?? DEFAULTS.verificationExpiryMs,
      resetExpiryMs: user.resetExpiryMs ?? DEFAULTS.resetExpiryMs,
      invitationExpiryMs: user.invitationExpiryMs ?? DEFAULTS.invitationExpiryMs,
      maxRetries: user.maxRetries ?? DEFAULTS.maxRetries,
      retryBaseDelayMs: user.retryBaseDelayMs ?? DEFAULTS.retryBaseDelayMs,
      retryMaxDelayMs: user.retryMaxDelayMs ?? DEFAULTS.retryMaxDelayMs,
      adminTestRecipient: user.adminTestRecipient,
    };
  }
  return {
    transport: 'mock',
    smtpHost: '',
    smtpPort: 0,
    smtpUser: '',
    smtpPassword: '',
    smtpSecure: false,
    smtpTlsServername: undefined,
    fromEmail: user?.fromEmail ?? DEFAULTS.fromEmail,
    fromName: user?.fromName ?? DEFAULTS.fromName,
    connectionTimeoutMs: DEFAULTS.connectionTimeoutMs,
    deliveryTimeoutMs: DEFAULTS.deliveryTimeoutMs,
    verificationExpiryMs: DEFAULTS.verificationExpiryMs,
    resetExpiryMs: DEFAULTS.resetExpiryMs,
    invitationExpiryMs: DEFAULTS.invitationExpiryMs,
    maxRetries: DEFAULTS.maxRetries,
    retryBaseDelayMs: DEFAULTS.retryBaseDelayMs,
    retryMaxDelayMs: DEFAULTS.retryMaxDelayMs,
    adminTestRecipient: user?.adminTestRecipient,
  };
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

export interface EmailResult {
  jobId: string;
  status: EmailStatus;
  providerMessageId?: string | null;
  acceptedRecipients: string[];
  rejectedRecipients: string[];
  error?: string | null;
}

export interface EmailTransport {
  send(mail: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ accepted: unknown; rejected: unknown; messageId?: string | null }>;
  verify?(): Promise<{ ok: boolean; message: string }>;
  readonly name: string;
}

function normAddressList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap((a) => (typeof a === 'string' ? [a] : a && typeof a === 'object' && 'address' in a ? [(a as { address: string }).address] : []));
  if (typeof v === 'string') return [v];
  if (typeof v === 'object' && 'address' in v) return [(v as { address: string }).address];
  return [];
}

// A real SMTP transport built on top of nodemailer.
function buildSmtpTransport(cfg: EmailConfig): EmailTransport {
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort ?? 587,
    secure: cfg.smtpSecure ?? false,
    auth: cfg.smtpUser && cfg.smtpPassword ? { user: cfg.smtpUser, pass: cfg.smtpPassword } : undefined,
    tls: cfg.smtpTlsServername ? { servername: cfg.smtpTlsServername, rejectUnauthorized: true } : { rejectUnauthorized: true },
  } as Parameters<typeof nodemailer.createTransport>[0]);

  return {
    get name() {
      return `nodemailer-smtp[${cfg.smtpHost}:${cfg.smtpPort ?? 587}]`;
    },
    async send(mail) {
      const info = await transporter.sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: { 'X-Mailer': 'FlashSpace' },
      });
      return {
        accepted: info.accepted ?? [],
        rejected: info.rejected ?? [],
        messageId: info.messageId ?? null,
      };
    },
    async verify() {
      try {
        const ok = await transporter.verify();
        return { ok, message: ok ? 'SMTP connection verified' : 'SMTP verification failed' };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// A mock transport that logs the intended delivery without sending anything.
function buildMockTransport(cfg: EmailConfig): EmailTransport {
  return {
    get name() {
      return 'mock';
    },
    async send(mail) {
      return { accepted: [mail.to], rejected: [], messageId: `mock-${crypto.randomUUID()}` };
    },
    async verify() {
      return { ok: false, message: 'No email provider configured; mock mode in use.' };
    },
  };
}

// ---------------------------------------------------------------------------
// Token helpers (used by sendEmail to build links)
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function urlEncode(s: string): string {
  return encodeURIComponent(s);
}

// The web client uses hash routing (#/route). Links must land on those routes,
// not on paths the SPA never serves.
function appLink(baseUrl: string, route: string, param: string, token: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/#/${route}?${param}=${urlEncode(token)}`;
}

function verifyLink(token: string, baseUrl: string): string {
  return appLink(baseUrl, 'verify', 'token', token);
}

function resetLink(token: string, baseUrl: string): string {
  return appLink(baseUrl, 'reset-password', 'token', token);
}

function invitationLink(token: string, baseUrl: string): string {
  return appLink(baseUrl, 'join', 'token', token);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const BRAND = 'FlashSpace';

function htmlWrap(body: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2933; line-height: 1.6; margin: 0; padding: 24px; background: #f4f6f8; }
    .wrap { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    h1 { font-size: 22px; margin: 0 0 16px; color: #0b2b3c; }
    p { margin: 0 0 14px; }
    a.button { display: inline-block; padding: 12px 22px; background: #0b7c5a; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; }
    a.button:hover { background: #096147; }
    .footer { margin-top: 28px; font-size: 12px; color: #6b7686; border-top: 1px solid #e3e8ee; padding-top: 16px; }
    .muted { color: #6b7686; }
    code { background: #eef2f6; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    ${body}
    <div class="footer">
      You received this email because of your activity in ${BRAND}.
      If you did not expect this email, please ignore it. Do not share the links below with anyone.
      <br><br>
      ${BRAND} &mdash; FlashSpace
    </div>
  </div>
</body>
</html>
  `.trim();
}

function textWrap(body: string): string {
  return [body, '', `You received this email because of your activity in ${BRAND}.`, 'If you did not expect this email, please ignore it. Do not share the links below with anyone.', '', `${BRAND} — FlashSpace`].join('\n');
}

function escapeHtml(s: unknown): string {
  const str = String(s ?? '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderEmailVerification(data: { firstName: string; verificationUrl: string; expiresInHours: number }) {
  const body = `
    <h1>Confirm your ${BRAND} email</h1>
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>Thanks for joining ${BRAND}. Please confirm your email address by clicking the button below:</p>
    <p><a class="button" href="${escapeHtml(data.verificationUrl)}">Confirm email address</a></p>
    <p>This link expires in ${escapeHtml(data.expiresInHours)} hours. If the button does not work, copy and paste this link into your browser:</p>
    <p class="muted"><code>${escapeHtml(data.verificationUrl)}</code></p>
    <p>If you did not create an account, you can safely ignore this email.</p>
  `.trim();
  return { subject: `Confirm your ${BRAND} email`, html: htmlWrap(body), text: textWrap(body) };
}

function renderPasswordReset(data: { firstName: string; resetUrl: string; expiresInHours: number }) {
  const body = `
    <h1>Reset your ${BRAND} password</h1>
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>We received a request to reset the password for your ${BRAND} account. Click the button below to choose a new password:</p>
    <p><a class="button" href="${escapeHtml(data.resetUrl)}">Reset password</a></p>
    <p>This link expires in ${escapeHtml(data.expiresInHours)} hours. If the button does not work, copy and paste this link into your browser:</p>
    <p class="muted"><code>${escapeHtml(data.resetUrl)}</code></p>
    <p>If you did not request this, you can safely ignore this email. Your password will not be changed.</p>
  `.trim();
  return { subject: `Reset your ${BRAND} password`, html: htmlWrap(body), text: textWrap(body) };
}

function renderSpaceInvitation(data: { inviterName: string; spaceName: string; invitedAs: string; invitationUrl: string; expiresInDays: number }) {
  const body = `
    <h1>You've been invited to ${escapeHtml(data.spaceName)}</h1>
    <p>Hi there,</p>
    <p>${escapeHtml(data.inviterName)} invited you to join <strong>${escapeHtml(data.spaceName)}</strong> as a <strong>${escapeHtml(data.invitedAs)}</strong>.</p>
    <p><a class="button" href="${escapeHtml(data.invitationUrl)}">Accept invitation</a></p>
    <p>This invitation expires in ${escapeHtml(data.expiresInDays)} days. If the button does not work, copy and paste this link into your browser:</p>
    <p class="muted"><code>${escapeHtml(data.invitationUrl)}</code></p>
    <p>If you did not expect this invitation, you can safely ignore this email.</p>
  `.trim();
  return { subject: `Invitation to ${escapeHtml(data.spaceName)}`, html: htmlWrap(body), text: textWrap(body) };
}

function renderJoinRequestReceived(data: { spaceName: string; requesterName: string }) {
  const body = `
    <h1>New join request for ${escapeHtml(data.spaceName)}</h1>
    <p>${escapeHtml(data.requesterName)} has requested to join <strong>${escapeHtml(data.spaceName)}</strong>.</p>
    <p>You can review and respond to this request from your ${BRAND} dashboard.</p>
    <p>This is an automated notification from ${BRAND}.</p>
  `.trim();
  return { subject: `New join request for ${escapeHtml(data.spaceName)}`, html: htmlWrap(body), text: textWrap(body) };
}

function renderJoinRequestApproved(data: { spaceName: string; memberName: string }) {
  const body = `
    <h1>Your join request to ${escapeHtml(data.spaceName)} was approved</h1>
    <p>Hi ${escapeHtml(data.memberName)},</p>
    <p>Your request to join <strong>${escapeHtml(data.spaceName)}</strong> has been approved. You can now sign in and access the Space.</p>
    <p>This is an automated notification from ${BRAND}.</p>
  `.trim();
  return { subject: `Your request to join ${escapeHtml(data.spaceName)} was approved`, html: htmlWrap(body), text: textWrap(body) };
}

function renderJoinRequestDeclined(data: { spaceName: string; memberName: string }) {
  const body = `
    <h1>Your join request to ${escapeHtml(data.spaceName)} was declined</h1>
    <p>Hi ${escapeHtml(data.memberName)},</p>
    <p>Your request to join <strong>${escapeHtml(data.spaceName)}</strong> was not approved.</p>
    <p>If you believe this is a mistake, contact the Space owner through ${BRAND}.</p>
    <p>This is an automated notification from ${BRAND}.</p>
  `.trim();
  return { subject: `Your request to join ${escapeHtml(data.spaceName)} was declined`, html: htmlWrap(body), text: textWrap(body) };
}

function renderSpaceExpiryWarning(data: { spaceName: string; expiryDate: string; ownerName: string }) {
  const body = `
    <h1>${escapeHtml(data.spaceName)} is expiring soon</h1>
    <p>Hi ${escapeHtml(data.ownerName)},</p>
    <p>The Space <strong>${escapeHtml(data.spaceName)}</strong> is scheduled to expire on <strong>${escapeHtml(data.expiryDate)}</strong>.</p>
    <p>You can extend the Space's lifetime from your ${BRAND} dashboard if you want to keep it active.</p>
    <p>This is an automated notification from ${BRAND}.</p>
  `.trim();
  return { subject: `${escapeHtml(data.spaceName)} is expiring soon`, html: htmlWrap(body), text: textWrap(body) };
}

function renderArchiveCompleted(data: { spaceName: string; archiveId: string; fileCount: number; sizeBytes: number; createdAt: string }) {
  const sizeMB = (data.sizeBytes / (1024 * 1024)).toFixed(2);
  const body = `
    <h1>Archive completed for ${escapeHtml(data.spaceName)}</h1>
    <p>An archive of <strong>${escapeHtml(data.spaceName)}</strong> has been created successfully.</p>
    <p class="muted">Archive ID: <code>${escapeHtml(data.archiveId)}</code><br>Files: ${escapeHtml(String(data.fileCount))}<br>Size: ${escapeHtml(sizeMB)} MB<br>Created: ${escapeHtml(data.createdAt)}</p>
    <p>You can download the archive from your Vault in ${BRAND}.</p>
    <p>This is an automated notification from ${BRAND}.</p>
  `.trim();
  return { subject: `Archive completed for ${escapeHtml(data.spaceName)}`, html: htmlWrap(body), text: textWrap(body) };
}

function renderArchiveFailed(data: { spaceName: string; archiveId: string; reason: string; createdAt: string }) {
  const body = `
    <h1>Archive failed for ${escapeHtml(data.spaceName)}</h1>
    <p>We could not complete the archive of <strong>${escapeHtml(data.spaceName)}</strong>.</p>
    <p class="muted">Archive ID: <code>${escapeHtml(data.archiveId)}</code><br>Failed at: ${escapeHtml(data.createdAt)}</p>
    <p>Reason: ${escapeHtml(data.reason)}</p>
    <p>Please try again from your Vault in ${BRAND}, or contact support if the problem continues.</p>
    <p>This is an automated notification from ${BRAND}.</p>
  `.trim();
  return { subject: `Archive failed for ${escapeHtml(data.spaceName)}`, html: htmlWrap(body), text: textWrap(body) };
}

function renderExtensionApproved(data: { spaceName: string; newExpiry: string; requesterName: string }) {
  const body = `
    <h1>Extension approved for ${escapeHtml(data.spaceName)}</h1>
    <p>Hi ${escapeHtml(data.requesterName)},</p>
    <p>Your request to extend <strong>${escapeHtml(data.spaceName)}</strong> was approved. The Space will now expire on <strong>${escapeHtml(data.newExpiry)}</strong>.</p>
    <p>This is an automated notification from ${BRAND}.</p>
  `.trim();
  return { subject: `Extension approved for ${escapeHtml(data.spaceName)}`, html: htmlWrap(body), text: textWrap(body) };
}

function renderExtensionRejected(data: { spaceName: string; requesterName: string; reason?: string }) {
  const reasonParagraph = data.reason ? `<p>Reason: ${escapeHtml(data.reason)}</p>` : '';
  const body = `
    <h1>Extension request declined for ${escapeHtml(data.spaceName)}</h1>
    <p>Hi ${escapeHtml(data.requesterName)},</p>
    <p>Your request to extend <strong>${escapeHtml(data.spaceName)}</strong> was not approved.</p>
    ${reasonParagraph}
    <p>If you believe this is a mistake, contact the Space owner through ${BRAND}.</p>
    <p>This is an automated notification from ${BRAND}.</p>
  `.trim();
  return { subject: `Extension request declined for ${escapeHtml(data.spaceName)}`, html: htmlWrap(body), text: textWrap(body) };
}

function renderMemberRoleChanged(data: { spaceName: string; memberName: string; newRole: string; changedByName: string }) {
  const body = `
    <h1>Your role in ${escapeHtml(data.spaceName)} changed</h1>
    <p>Hi ${escapeHtml(data.memberName)},</p>
    <p>Your role in <strong>${escapeHtml(data.spaceName)}</strong> was changed to <strong>${escapeHtml(data.newRole)}</strong> by ${escapeHtml(data.changedByName)}.</p>
    <p>This is an automated notification from ${BRAND}.</p>
  `.trim();
  return { subject: `Your role in ${escapeHtml(data.spaceName)} changed`, html: htmlWrap(body), text: textWrap(body) };
}

function renderMemberRemoved(data: { spaceName: string; memberName: string; removedByName: string }) {
  const body = `
    <h1>You were removed from ${escapeHtml(data.spaceName)}</h1>
    <p>Hi ${escapeHtml(data.memberName)},</p>
    <p>You were removed from <strong>${escapeHtml(data.spaceName)}</strong> by ${escapeHtml(data.removedByName)}.</p>
    <p>You no longer have access to this Space.</p>
    <p>This is an automated notification from ${BRAND}.</p>
  `.trim();
  return { subject: `You were removed from ${escapeHtml(data.spaceName)}`, html: htmlWrap(body), text: textWrap(body) };
}

const TEMPLATE_RENDERERS: Record<EmailTemplate, (data: Record<string, unknown>) => { subject: string; html: string; text: string }> = {
  'email-verification': (d) => renderEmailVerification({ firstName: String(d.firstName ?? ''), verificationUrl: String(d.verificationUrl), expiresInHours: Math.round(Number(d.expiresInHours) || 24) }),
  'password-reset': (d) => renderPasswordReset({ firstName: String(d.firstName ?? ''), resetUrl: String(d.resetUrl), expiresInHours: Math.round(Number(d.expiresInHours) || 1) }),
  'space-invitation': (d) => renderSpaceInvitation({ inviterName: String(d.inviterName ?? ''), spaceName: String(d.spaceName ?? ''), invitedAs: String(d.invitedAs ?? 'member'), invitationUrl: String(d.invitationUrl), expiresInDays: Math.max(1, Math.round(Number(d.expiresInDays) || 7)) }),
  'join-request-received': (d) => renderJoinRequestReceived({ spaceName: String(d.spaceName ?? ''), requesterName: String(d.requesterName ?? '') }),
  'join-request-approved': (d) => renderJoinRequestApproved({ spaceName: String(d.spaceName ?? ''), memberName: String(d.memberName ?? '') }),
  'join-request-declined': (d) => renderJoinRequestDeclined({ spaceName: String(d.spaceName ?? ''), memberName: String(d.memberName ?? '') }),
  'space-expiry-warning': (d) => renderSpaceExpiryWarning({ spaceName: String(d.spaceName ?? ''), expiryDate: String(d.expiryDate ?? ''), ownerName: String(d.ownerName ?? '') }),
  'archive-completed': (d) => renderArchiveCompleted({ spaceName: String(d.spaceName ?? ''), archiveId: String(d.archiveId ?? ''), fileCount: Number(d.fileCount) || 0, sizeBytes: Number(d.sizeBytes) || 0, createdAt: String(d.createdAt ?? '') }),
  'archive-failed': (d) => renderArchiveFailed({ spaceName: String(d.spaceName ?? ''), archiveId: String(d.archiveId ?? ''), reason: String(d.reason ?? 'Unknown error during archive.'), createdAt: String(d.createdAt ?? '') }),
  'extension-approved': (d) => renderExtensionApproved({ spaceName: String(d.spaceName ?? ''), newExpiry: String(d.newExpiry ?? ''), requesterName: String(d.requesterName ?? '') }),
  'extension-rejected': (d) => renderExtensionRejected({ spaceName: String(d.spaceName ?? ''), requesterName: String(d.requesterName ?? ''), reason: d.reason ? String(d.reason) : undefined }),
  'member-role-changed': (d) => renderMemberRoleChanged({ spaceName: String(d.spaceName ?? ''), memberName: String(d.memberName ?? ''), newRole: String(d.newRole ?? ''), changedByName: String(d.changedByName ?? '') }),
  'member-removed': (d) => renderMemberRemoved({ spaceName: String(d.spaceName ?? ''), memberName: String(d.memberName ?? ''), removedByName: String(d.removedByName ?? '') }),
  // Admin configuration check: the subject/body are supplied by the caller.
  'test': (d) => ({
    subject: String(d.subject ?? 'FlashSpace test email'),
    html: String(d.html ?? ''),
    text: String(d.text ?? ''),
  }),
};

// ---------------------------------------------------------------------------
// EmailService
// ---------------------------------------------------------------------------

export class EmailService {
  private cfg: EmailConfig;
  private readonly dl: DataLayer;
  private readonly baseUrl: string;
  private transport: EmailTransport;
  /** Rendered messages captured while the mock transport is active. */
  private readonly outboxMessages: Array<Record<string, unknown>> = [];

  constructor(dl: DataLayer, baseUrl: string, userConfig?: Partial<EmailConfig>) {
    this.dl = dl;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cfg = resolveConfig(userConfig);
    this.transport = this.cfg.transport === 'smtp' ? buildSmtpTransport(this.cfg) : buildMockTransport(this.cfg);
  }

  rebind(userConfig?: Partial<EmailConfig>): void {
    this.cfg = resolveConfig(userConfig ?? this.cfg);
    this.transport = this.cfg.transport === 'smtp' ? buildSmtpTransport(this.cfg) : buildMockTransport(this.cfg);
  }

  get config(): Readonly<EmailConfig> {
    return this.cfg;
  }

  get transportName(): string {
    return this.transport.name;
  }

  async sendEmail(
    category: EmailCategory,
    template: EmailTemplate,
    to: string,
    subject: string,
    entityId: string,
    entityType: string,
    renderVars: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<EmailResult> {
    const jobId = crypto.randomUUID();
    const job: EmailJobRow = {
      id: jobId,
      category,
      template,
      to,
      subject,
      entityId,
      entityType,
      status: 'PENDING',
      attempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastAttemptAt: null,
      deliveredAt: null,
      error: null,
      idempotencyKey: idempotencyKey ?? null,
    };

    // Duplicate delivery prevention: one SENT job per entity+template+recipient.
    const existing = await this.dl.emailJobs.findByEntity(entityType, entityId);
    if (
      existing &&
      existing.template === template &&
      existing.to === to &&
      existing.status === 'SENT'
    ) {
      return {
        jobId: existing.id,
        status: 'SENT',
        providerMessageId: existing.deliveredAt ?? null,
        acceptedRecipients: [to],
        rejectedRecipients: [],
      };
    }

    await this.dl.emailJobs.insert(job);
    const rendered = TEMPLATE_RENDERERS[template](renderVars);

    try {
      await this.dl.emailJobs.update(jobId, { status: 'PROCESSING', updatedAt: nowIso(), lastAttemptAt: nowIso() });

      const result = await this.transport.send({
        from: `"${this.cfg.fromName}" <${this.cfg.fromEmail}>`,
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      const accepted = normAddressList(result.accepted);
      const rejected = normAddressList(result.rejected);

      if (accepted.length > 0) {
        await this.dl.emailJobs.update(jobId, { status: 'SENT', attempts: 1, updatedAt: nowIso(), lastAttemptAt: nowIso(), deliveredAt: nowIso(), error: null });
        if (this.cfg.transport === 'mock') {
          // Local development has no mail server. Keep the rendered message so
          // /dev/outbox can show exactly what would have been delivered.
          this.outboxMessages.unshift({
            id: jobId,
            category,
            template,
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            createdAt: nowIso(),
            transport: 'mock',
          });
          if (this.outboxMessages.length > 100) this.outboxMessages.length = 100;
        }
        return { jobId, status: 'SENT', providerMessageId: result.messageId ?? null, acceptedRecipients: accepted, rejectedRecipients: rejected };
      }

      throw new Error(`SMTP delivery rejected for ${to}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextAttempts = (job.attempts ?? 0) + 1;

      if (nextAttempts >= this.cfg.maxRetries) {
        await this.dl.emailJobs.update(jobId, { status: 'FAILED', attempts: nextAttempts, updatedAt: nowIso(), lastAttemptAt: nowIso(), error: message });
        return { jobId, status: 'FAILED', providerMessageId: null, acceptedRecipients: [], rejectedRecipients: [to], error: message };
      }

      const delayMs = Math.min(this.cfg.retryMaxDelayMs, this.cfg.retryBaseDelayMs * 2 ** (nextAttempts - 1));
      const retryAt = new Date(Date.now() + delayMs).toISOString();
      await this.dl.emailJobs.update(jobId, { status: 'RETRY_SCHEDULED', attempts: nextAttempts, updatedAt: nowIso(), lastAttemptAt: nowIso(), error: message });
      this.retryLater(jobId, retryAt);
      return { jobId, status: 'RETRY_SCHEDULED', providerMessageId: null, acceptedRecipients: [], rejectedRecipients: [to], error: message };
    }
  }

  /** Fire-and-forget retry. Does not await; updates job row in place. */
  private async retryLater(jobId: string, retryAt: string): Promise<void> {
    const delayMs = Math.max(0, new Date(retryAt).getTime() - Date.now());
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    try {
      const job = await this.dl.emailJobs.findById(jobId);
      if (!job || job.status !== 'RETRY_SCHEDULED') return;

      await this.dl.emailJobs.update(jobId, { status: 'PROCESSING', attempts: job.attempts, updatedAt: nowIso(), lastAttemptAt: nowIso() });

      // Best-effort resend using a minimal render. Callers wanting fresh content
      // should call sendEmail directly.
      const rendered = TEMPLATE_RENDERERS[job.template as EmailTemplate]({
        firstName: '', inviterName: '', spaceName: '', requesterName: '', memberName: '',
        newExpiry: '', reason: '', invitedAs: '', verificationUrl: '', resetUrl: '', invitationUrl: '',
        expiresInHours: 24, expiresInDays: 7, fileCount: 0, sizeBytes: 0, archiveId: '', createdAt: '',
      });

      const result = await this.transport.send({
        from: `"${this.cfg.fromName}" <${this.cfg.fromEmail}>`,
        to: job.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      if (normAddressList(result.accepted).length > 0) {
        await this.dl.emailJobs.update(jobId, { status: 'SENT', attempts: job.attempts + 1, updatedAt: nowIso(), lastAttemptAt: nowIso(), deliveredAt: nowIso(), error: null });
      } else {
        const nextAttempts = (job.attempts ?? 0) + 1;
        if (nextAttempts >= this.cfg.maxRetries) {
          await this.dl.emailJobs.update(jobId, { status: 'FAILED', attempts: nextAttempts, updatedAt: nowIso(), lastAttemptAt: nowIso(), error: 'SMTP delivery rejected after retries' });
        } else {
          const delayMs = Math.min(this.cfg.retryMaxDelayMs, this.cfg.retryBaseDelayMs * 2 ** (nextAttempts - 1));
          this.retryLater(jobId, new Date(Date.now() + delayMs).toISOString());
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const job = await this.dl.emailJobs.findById(jobId);
      if (!job) return;
      const nextAttempts = (job.attempts ?? 0) + 1;
      if (nextAttempts >= this.cfg.maxRetries) {
        await this.dl.emailJobs.update(jobId, { status: 'FAILED', attempts: nextAttempts, updatedAt: nowIso(), lastAttemptAt: nowIso(), error: message });
      } else {
        const delayMs = Math.min(this.cfg.retryMaxDelayMs, this.cfg.retryBaseDelayMs * 2 ** (nextAttempts - 1));
        this.retryLater(jobId, new Date(Date.now() + delayMs).toISOString());
      }
    }
  }

  // ---- High-level transactional flows -------------------------------------

  async sendVerificationEmail(to: string, displayName: string, token: string): Promise<EmailResult> {
    return this.sendEmail('VERIFICATION', 'email-verification', to, `Confirm your ${this.cfg.fromName} email`, `verify:${token}`, 'email-verification', { firstName: displayName, verificationUrl: verifyLink(token, this.baseUrl), expiresInHours: Math.round(this.cfg.verificationExpiryMs / 3600000) });
  }

  async sendPasswordResetEmail(to: string, displayName: string, token: string): Promise<EmailResult> {
    return this.sendEmail('SECURITY', 'password-reset', to, `Reset your ${this.cfg.fromName} password`, `reset:${token}`, 'password-reset', { firstName: displayName, resetUrl: resetLink(token, this.baseUrl), expiresInHours: Math.round(this.cfg.resetExpiryMs / 3600000) });
  }

  async sendInvitationEmail(to: string, inviterName: string, spaceName: string, intendedRole: MemberRole, token: string): Promise<EmailResult> {
    return this.sendEmail('INVITATIONS', 'space-invitation', to, `Invitation to ${spaceName}`, `invite:${spaceName}:${token}`, 'space-invitation', { inviterName, spaceName, invitedAs: intendedRole, invitationUrl: invitationLink(token, this.baseUrl), expiresInDays: Math.round(this.cfg.invitationExpiryMs / 86400000) });
  }

  async sendJoinRequestReceivedEmail(to: string, spaceName: string, requesterName: string, spaceId: string): Promise<EmailResult> {
    return this.sendEmail('JOIN_REQUESTS', 'join-request-received', to, `New join request for ${spaceName}`, spaceId, 'space', { spaceName, requesterName });
  }

  async sendJoinRequestApprovedEmail(to: string, spaceName: string, memberName: string, joinRequestId: string): Promise<EmailResult> {
    return this.sendEmail('JOIN_REQUESTS', 'join-request-approved', to, `Your request to join ${spaceName} was approved`, joinRequestId, 'join-request', { spaceName, memberName });
  }

  async sendJoinRequestDeclinedEmail(to: string, spaceName: string, memberName: string, joinRequestId: string): Promise<EmailResult> {
    return this.sendEmail('JOIN_REQUESTS', 'join-request-declined', to, `Your request to join ${spaceName} was declined`, joinRequestId, 'join-request', { spaceName, memberName });
  }

  async sendExpiryWarningEmail(to: string, spaceName: string, ownerName: string, expiryDate: string, spaceId: string): Promise<EmailResult> {
    return this.sendEmail('SPACE_LIFECYCLE', 'space-expiry-warning', to, `${spaceName} is expiring soon`, spaceId, 'space', { spaceName, ownerName, expiryDate });
  }

  async sendArchiveCompletedEmail(to: string, spaceName: string, archiveId: string, fileCount: number, sizeBytes: number, createdAt: string, archiveIdEntity: string): Promise<EmailResult> {
    return this.sendEmail('ARCHIVES', 'archive-completed', to, `Archive completed for ${spaceName}`, archiveIdEntity, 'archive', { spaceName, archiveId, fileCount, sizeBytes, createdAt });
  }

  async sendArchiveFailedEmail(to: string, spaceName: string, archiveId: string, reason: string, createdAt: string, archiveIdEntity: string): Promise<EmailResult> {
    return this.sendEmail('ARCHIVES', 'archive-failed', to, `Archive failed for ${spaceName}`, archiveIdEntity, 'archive', { spaceName, archiveId, reason, createdAt });
  }

  async sendExtensionApprovedEmail(to: string, spaceName: string, requesterName: string, newExpiry: string, extensionId: string): Promise<EmailResult> {
    return this.sendEmail('EXTENSIONS', 'extension-approved', to, `Extension approved for ${spaceName}`, extensionId, 'extension-request', { spaceName, requesterName, newExpiry });
  }

  async sendExtensionRejectedEmail(to: string, spaceName: string, requesterName: string, extensionId: string, reason?: string): Promise<EmailResult> {
    return this.sendEmail('EXTENSIONS', 'extension-rejected', to, `Extension request declined for ${spaceName}`, extensionId, 'extension-request', { spaceName, requesterName, reason });
  }

  async sendMemberRoleChangedEmail(to: string, spaceName: string, memberName: string, newRole: string, changedByName: string, memberId: string): Promise<EmailResult> {
    return this.sendEmail('MEMBERSHIP', 'member-role-changed', to, `Your role in ${spaceName} changed`, memberId, 'space-member', { spaceName, memberName, newRole, changedByName });
  }

  async sendMemberRemovedEmail(to: string, spaceName: string, memberName: string, removedByName: string, memberId: string): Promise<EmailResult> {
    return this.sendEmail('MEMBERSHIP', 'member-removed', to, `You were removed from ${spaceName}`, memberId, 'space-member', { spaceName, memberName, removedByName });
  }

  // ---- Admin / test helpers ----------------------------------------------

  async verifyConnection(): Promise<{ ok: boolean; message: string }> {
    if (this.cfg.transport === 'mock') {
      return { ok: false, message: 'No email provider configured; mock mode in use.' };
    }
    return (this.transport.verify?.() ?? Promise.resolve({ ok: false, message: 'Provider does not support verification.' })) as Promise<{ ok: boolean; message: string }>;
  }

  async sendTestEmail(to: string, subject: string, bodyHtml: string, bodyText: string): Promise<EmailResult> {
    return this.sendEmail('SYSTEM', 'test', to, subject, 'test', 'test', {
      subject,
      html: bodyHtml,
      text: bodyText,
    });
  }

  async resendJob(jobId: string): Promise<EmailResult> {
    const job = await this.dl.emailJobs.findById(jobId);
    if (!job) return { jobId, status: 'FAILED', providerMessageId: null, acceptedRecipients: [], rejectedRecipients: [], error: `No email job with id ${jobId}` };
    if (job.status !== 'FAILED' && job.status !== 'RETRY_SCHEDULED') {
      return { jobId, status: 'FAILED', providerMessageId: null, acceptedRecipients: [], rejectedRecipients: [], error: `Job ${jobId} is not in a retryable state (${job.status})` };
    }
    return this.sendEmail(job.category as EmailCategory, job.template as EmailTemplate, job.to, job.subject, job.entityId, job.entityType, {}, job.idempotencyKey ?? undefined);
  }

  async listJobs(category: EmailCategory | null, search: string | null, status: EmailStatus | null, limit = 50, offset = 0): Promise<{ rows: EmailJobRow[]; total: number }> {
    const rows = (await this.dl.emailJobs.listAll(200)) as EmailJobRow[];
    let filtered = rows;
    if (category) filtered = filtered.filter((r) => r.category === category);
    if (status) filtered = filtered.filter((r) => r.status === status);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter((r) => r.to.toLowerCase().includes(q) || r.subject.toLowerCase().includes(q) || r.template.toLowerCase().includes(q) || r.category.toLowerCase().includes(q) || r.entityId.toLowerCase().includes(q) || r.entityType.toLowerCase().includes(q));
    }
    filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { rows: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  async getJob(id: string): Promise<EmailJobRow | undefined> {
    return this.dl.emailJobs.findById(id);
  }

  async retryJob(id: string): Promise<EmailResult | null> {
    const job = await this.dl.emailJobs.findById(id);
    if (!job || (job.status !== 'FAILED' && job.status !== 'RETRY_SCHEDULED')) return null;
    return this.resendJob(id);
  }

  get isMockMode(): boolean {
    return this.cfg.transport === 'mock';
  }

  /** Mock transport only: the rendered messages a real provider would have sent. */
  listOutbox(limit = 25): Array<Record<string, unknown>> {
    return this.outboxMessages.slice(0, limit);
  }

  clearOutbox(): void {
    this.outboxMessages.length = 0;
  }
}
