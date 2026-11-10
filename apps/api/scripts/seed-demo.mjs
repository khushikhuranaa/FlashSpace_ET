#!/usr/bin/env node
/**
 * Seeds a running FlashSpace API with a small demo dataset and prints the
 * demo accounts. Usage: npm run seed:demo  (API must be running on :4000).
 */
const API = process.env.API_URL ?? 'http://localhost:4000';

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 204) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

const users = [
  { email: 'admin@demo.dev', name: 'Ada Admin' },
  { email: 'owner@demo.dev', name: 'Olive Owner' },
  { email: 'editor@demo.dev', name: 'Eli Editor' },
  { email: 'viewer@demo.dev', name: 'Vera Viewer' },
];

const tokens = {};
for (const u of users) {
  try {
    const r = await call('/auth/register', {
      method: 'POST',
      body: { email: u.email, password: 'demopassword', displayName: u.name },
    });
    tokens[u.email] = r.token;
    console.log(`created ${u.email}`);
  } catch (err) {
    const r = await call('/auth/login', { method: 'POST', body: { email: u.email, password: 'demopassword' } });
    tokens[u.email] = r.token;
    console.log(`exists  ${u.email}`);
  }
}

const owner = tokens['owner@demo.dev'];

const days = (n) => new Date(Date.now() + n * 86400000).toISOString();
const launch = await call('/spaces', {
  method: 'POST',
  token: owner,
  body: {
    name: 'Q3 Marketing Site',
    purpose: 'Ship the relaunch',
    description: 'Closes after launch week. Everything archives to the Vault.',
    startAt: days(-2),
    expiryAt: days(14),
  },
});
console.log('space    Q3 Marketing Site', launch.space.status);

await call(`/spaces/${launch.space.id}/invitations`, { method: 'POST', token: owner, body: { email: 'editor@demo.dev', role: 'EDITOR' } });
await call(`/spaces/${launch.space.id}/invitations`, { method: 'POST', token: owner, body: { email: 'viewer@demo.dev', role: 'VIEWER' } });
console.log('invited  editor + viewer');

const files = [
  { name: 'launch-brief.md', body: '# Launch brief\n\nShip it. Then let the Space expire.' },
  { name: 'checklist.txt', body: '- [x] hero copy\n- [x] screenshots\n- [ ] press release' },
];
for (const f of files) {
  const init = await call(`/spaces/${launch.space.id}/files/init-upload`, {
    method: 'POST',
    token: owner,
    body: { name: f.name, mimeType: 'text/plain', sizeBytes: f.body.length },
  });
  await fetch(init.url, { method: 'PUT', body: f.body });
  await call(`/spaces/${launch.space.id}/files/${init.fileId}/confirm-upload`, { method: 'POST', token: owner });
  console.log(`uploaded ${f.name}`);
}

const expired = await call('/spaces', {
  method: 'POST',
  token: owner,
  body: {
    name: 'Retro Sprint 12',
    purpose: 'Old sprint hub (about to archive)',
    startAt: days(-40),
    expiryAt: days(-1),
  },
});
const init = await call(`/spaces/${expired.space.id}/files/init-upload`, {
  method: 'POST',
  token: owner,
  body: { name: 'retro-notes.md', mimeType: 'text/markdown', sizeBytes: 44 },
});
await fetch(init.url, { method: 'PUT', body: '# Retro\n\nWhat went well: everything.\n' });
await call(`/spaces/${expired.space.id}/files/${init.fileId}/confirm-upload`, { method: 'POST', token: owner });
console.log('space    Retro Sprint 12 (expires in the past → archives on next lifecycle run)');

console.log('\nDemo accounts (password: demopassword):');
for (const u of users) console.log(`  ${u.email}`);
console.log('\nTrigger the lifecycle pass to watch the expired Space archive:');
console.log(`  curl -X POST ${API}/jobs/lifecycle/run -H "x-job-secret: dev-only-job-secret"`);
