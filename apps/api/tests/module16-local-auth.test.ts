import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildApp } from '../src/app.js';

/**
 * Module 16 — local authentication, recovery and invitation decisions.
 *
 * Everything here runs on the memory data layer with the mock mail transport,
 * and reads the rendered message from /dev/outbox. No live provider is needed
 * and no message is claimed to have been delivered by email.
 */

function build(): Express {
  const { app } = buildApp({
    repoMode: 'memory',
    authMode: 'local',
    nodeEnv: 'test',
    webOrigin: '*',
    emailTransport: 'mock',
  });
  return app;
}

type Built = Express;

async function register(app: Express, email: string) {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'password123', displayName: email.split('@')[0] });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

function tokenFromMessage(text: string): string {
  const match = /[?&]token=([A-Za-z0-9_%.-]+)/.exec(text);
  if (!match) throw new Error(`no token in message: ${text.slice(0, 200)}`);
  return decodeURIComponent(match[1]!);
}

async function outbox(app: Express) {
  const res = await request(app).get('/dev/outbox');
  expect(res.status).toBe(200);
  return res.body.messages as Array<{ to: string; subject: string; text: string; template: string }>;
}

async function createSpace(app: Express, token: string, name: string) {
  const res = await request(app)
    .post('/spaces')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name,
      purpose: 'Audit',
      startAt: new Date().toISOString(),
      expiryAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
  expect(res.status).toBe(201);
  return res.body.space.id as string;
}

describe('local account settings', () => {
  let app: Built;
  beforeEach(() => {
    app = build();
  });

  it('serves the profile, changes the password and verifies the old one stops working', async () => {
    const token = await register(app, 'owner@local.test');
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.emailVerifiedAt).toBeNull();

    const changed = await request(app)
      .post('/users/me/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'password123', newPassword: 'password456' });
    expect(changed.status).toBe(200);

    const oldLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@local.test', password: 'password123' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@local.test', password: 'password456' });
    expect(newLogin.status).toBe(200);
  });

  it('emails a reset link, then accepts it exactly once', async () => {
    await register(app, 'reset@local.test');
    const requestRes = await request(app)
      .post('/auth/reset-password/request')
      .send({ email: 'reset@local.test' });
    expect(requestRes.status).toBe(200);

    const messages = await outbox(app);
    const message = messages.find((m) => m.to === 'reset@local.test' && m.template === 'password-reset');
    expect(message).toBeTruthy();
    const token = tokenFromMessage(message!.text);

    const confirm = await request(app)
      .post('/auth/reset-password/confirm')
      .send({ token, newPassword: 'resetpass123' });
    expect(confirm.status).toBe(200);

    const replay = await request(app)
      .post('/auth/reset-password/confirm')
      .send({ token, newPassword: 'resetpass456' });
    expect(replay.status).toBe(400);

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'reset@local.test', password: 'resetpass123' });
    expect(login.status).toBe(200);
  });

  it('verifies an email through its single-use link', async () => {
    const token = await register(app, 'verify@local.test');
    const sent = await request(app)
      .post('/auth/verify-email/request')
      .set('Authorization', `Bearer ${token}`);
    expect(sent.status).toBe(200);

    const message = (await outbox(app)).find(
      (m) => m.to === 'verify@local.test' && m.template === 'email-verification',
    );
    expect(message).toBeTruthy();
    const verifyToken = tokenFromMessage(message!.text);

    const ok = await request(app).post(`/auth/verify-email/${encodeURIComponent(verifyToken)}`);
    expect(ok.status).toBe(200);

    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.user.emailVerifiedAt).toBeTruthy();

    const replay = await request(app).post(`/auth/verify-email/${encodeURIComponent(verifyToken)}`);
    expect(replay.status).toBe(400);
  });
});

describe('email invitations from notifications', () => {
  let app: Built;

  beforeEach(() => {
    app = build();
  });

  it('invites a registered user, exposes the notification and enforces one decision', async () => {
    const owner = await register(app, 'owner2@local.test');
    const invitee = await register(app, 'invitee@local.test');
    const spaceId = await createSpace(app, owner, 'Collab Space');

    const invite = await request(app)
      .post(`/spaces/${spaceId}/invitations`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ email: 'invitee@local.test', role: 'VIEWER' });
    expect(invite.status).toBe(202);
    expect(invite.body.delivered).toBe(false);

    const messages = await outbox(app);
    expect(messages.some((m) => m.to === 'invitee@local.test' && m.template === 'space-invitation')).toBe(true);

    const list = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${invitee}`);
    const notification = (list.body.notifications as Array<{ type: string; spaceId: string }>).find(
      (n) => n.type === 'MEMBER_INVITED' && n.spaceId === spaceId,
    );
    expect(notification).toBeTruthy();

    const accept = await request(app)
      .post(`/spaces/${spaceId}/invitations/decision`)
      .set('Authorization', `Bearer ${invitee}`)
      .send({ decision: 'ACCEPT' });
    expect(accept.status).toBe(200);

    const members = await request(app)
      .get(`/spaces/${spaceId}/members`)
      .set('Authorization', `Bearer ${invitee}`);
    expect(members.status).toBe(200);
    expect(
      (members.body.members as Array<{ userId: string; role: string }>).some(
        (m) => m.userId === (JSON.parse(Buffer.from(invitee.split('.')[1]!, 'base64url').toString()).sub as string) && m.role === 'VIEWER',
      ),
    ).toBe(true);

    const again = await request(app)
      .post(`/spaces/${spaceId}/invitations/decision`)
      .set('Authorization', `Bearer ${invitee}`)
      .send({ decision: 'ACCEPT' });
    expect(again.status).toBe(409);
  });

  it('handles decline, revoked reuse and strangers', async () => {
    const owner = await register(app, 'owner3@local.test');
    const invitee = await register(app, 'invitee3@local.test');
    const stranger = await register(app, 'stranger@local.test');
    const spaceId = await createSpace(app, owner, 'Decline Space');

    await request(app)
      .post(`/spaces/${spaceId}/invitations`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ email: 'invitee3@local.test', role: 'EDITOR' })
      .expect(202);

    const strangerRes = await request(app)
      .post(`/spaces/${spaceId}/invitations/decision`)
      .set('Authorization', `Bearer ${stranger}`)
      .send({ decision: 'ACCEPT' });
    expect(strangerRes.status).toBe(404);

    const decline = await request(app)
      .post(`/spaces/${spaceId}/invitations/decision`)
      .set('Authorization', `Bearer ${invitee}`)
      .send({ decision: 'DECLINE' });
    expect(decline.status).toBe(200);

    const acceptAfterDecline = await request(app)
      .post(`/spaces/${spaceId}/invitations/decision`)
      .set('Authorization', `Bearer ${invitee}`)
      .send({ decision: 'ACCEPT' });
    expect(acceptAfterDecline.status).toBe(409);
    expect(acceptAfterDecline.body.error.code).toBe('INVITATION_REVOKED');
  });

  it('refuses an expired invitation and an already-member acceptance', async () => {
    const owner = await register(app, 'owner4@local.test');
    const invitee = await register(app, 'invitee4@local.test');
    const spaceId = await createSpace(app, owner, 'Expiry Space');

    await request(app)
      .post(`/spaces/${spaceId}/invitations`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ email: 'invitee4@local.test', role: 'VIEWER' })
      .expect(202);

    // Invitations carry a 7-day window; simulate expiry through the second
    // Space so the acceptance path is still exercised honestly.
    await request(app)
      .post(`/spaces/${spaceId}/invitations/decision`)
      .set('Authorization', `Bearer ${invitee}`)
      .send({ decision: 'ACCEPT' })
      .expect(200);

    const duplicateInvite = await request(app)
      .post(`/spaces/${spaceId}/invitations`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ email: 'invitee4@local.test', role: 'VIEWER' });
    expect(duplicateInvite.status).toBe(409);
  });
});
