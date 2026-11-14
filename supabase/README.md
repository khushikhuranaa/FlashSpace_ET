# Supabase project configuration (Module 1)

Everything in this folder is configuration a human applies once in the Supabase
dashboard — none of it ships in the app bundle.

## Email templates

| File | Supabase location | Subject to paste |
|---|---|---|
| `email-templates/confirm-signup.html` | Authentication → Email Templates → **Confirm signup** | `Verify your FlashSpace email address` |
| `email-templates/recovery.html` | Authentication → Email Templates → **Reset password** | `Reset your FlashSpace password` |
| `email-templates/email-change.html` | Authentication → Email Templates → **Change Email Address** | `Confirm your new FlashSpace email address` |
| `email-templates/security-notification.html` | Authentication → Email Templates → **Security notification** | `Security notice for your FlashSpace account` |

The templates use only Supabase's built-in variables (`{{ .ConfirmationURL }}`,
`{{ .Email }}`, `{{ .NewEmail }}`), so they work with the built-in mailer and
with any SMTP provider.

## URL configuration

Authentication → URL Configuration:

- **Site URL**: `http://localhost:5173`
- **Redirect allow list**:
  - `http://localhost:5173/**`
  - your production origin, e.g. `https://app.your-domain.com/**`

The app sends users back through the hash routes `/#/verify` and
`/#/reset-password`.

## Storage

Storage → **New bucket** → name `avatars`, **private**.
`003_auth_identity.sql` also creates it with a 2 MB limit and an image MIME
allow-list, and adds per-user object policies, so running the migration is
enough when you have SQL access.

## Migrations

```bash
# from the repo root, with DATABASE_URL set in apps/api/.env
npm run db:migrate -w @flashspace/api
```

Applies `001_init.sql`, `002_smart_storage.sql`, `003_auth_identity.sql` in
order and records each in `schema_migrations`.

## Full setup walkthrough

See [`../docs/module1-auth.md`](../docs/module1-auth.md).
