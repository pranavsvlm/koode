import { env } from 'cloudflare:test';
import { authSigningMessage, AuthSession, TokenPair } from '@koode/shared';
import { describe, expect, it } from 'vitest';
import {
  api,
  challenge,
  login,
  newDevice,
  RECOVERY_KEY,
  registerUser,
  seedInvite,
} from './helpers';

describe('registration', () => {
  it('creates an account, device and session from a valid invite', async () => {
    const { status, json } = await registerUser();
    expect(status).toBe(201);
    const session = AuthSession.parse(json);
    expect(session.user).toMatchObject({ username: 'maya', displayName: 'Maya Chen', about: '' });

    const me = await api('/me', { token: session.accessToken });
    expect(me.status).toBe(200);
    expect(me.json.username).toBe('maya');

    // Bootstrap invite → first account administers the instance; secrets are hashed.
    const row = await env.DB.prepare('SELECT role, recovery_key_hash FROM users WHERE id = ?')
      .bind(session.user.id)
      .first<{ role: string; recovery_key_hash: string }>();
    expect(row?.role).toBe('admin');
    expect(row?.recovery_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.recovery_key_hash).not.toContain(RECOVERY_KEY);
  });

  it('rejects unknown, expired and used-up invites', async () => {
    expect((await registerUser({ inviteCode: 'ZZZZZZZZZZZZ' })).status).toBe(403);

    await seedInvite('EXP1RED00000', { expiresAt: Date.now() - 1 });
    expect((await registerUser({ inviteCode: 'EXP1RED00000' })).status).toBe(403);

    await seedInvite('0NCE0NE00000');
    expect((await registerUser({ inviteCode: '0NCE0NE00000', username: 'first' })).status).toBe(
      201,
    );
    expect((await registerUser({ inviteCode: '0NCE0NE00000', username: 'second' })).status).toBe(
      403,
    );
  });

  it('rejects taken usernames without consuming the invite', async () => {
    await registerUser();
    await seedInvite('SEC0NDC0DE00');
    const dup = await registerUser({ inviteCode: 'SEC0NDC0DE00', username: 'maya' });
    expect(dup.status).toBe(409);
    expect((await registerUser({ inviteCode: 'SEC0NDC0DE00', username: 'maya2' })).status).toBe(
      201,
    );
  });

  it('requires a signature from the key being registered', async () => {
    await seedInvite('K7QM4XRT9PWD');
    const device = await newDevice();
    const impostor = await newDevice();
    const nonce = await challenge('register');
    const res = await api('/auth/register', {
      body: {
        inviteCode: 'K7QM-4XRT-9PWD',
        username: 'maya',
        displayName: 'Maya',
        recoveryKey: RECOVERY_KEY,
        device: { name: 'iPhone', platform: 'ios', signingPublicKey: device.publicKey },
        nonce,
        signature: await impostor.sign(authSigningMessage('register', nonce, device.publicKey)),
      },
    });
    expect(res.status).toBe(401);
  });

  it('rejects replayed and wrong-purpose challenges', async () => {
    await seedInvite('K7QM4XRT9PWD');
    await seedInvite('ANTHERC0DE00');
    const device = await newDevice();
    const nonce = await challenge('register');
    const body = (inviteCode: string, username: string, sig: string, n = nonce) => ({
      inviteCode,
      username,
      displayName: 'Maya',
      recoveryKey: RECOVERY_KEY,
      device: { name: 'iPhone', platform: 'ios', signingPublicKey: device.publicKey },
      nonce: n,
      signature: sig,
    });
    const sig = await device.sign(authSigningMessage('register', nonce, device.publicKey));
    expect((await api('/auth/register', { body: body('K7QM4XRT9PWD', 'maya', sig) })).status).toBe(
      201,
    );
    expect((await api('/auth/register', { body: body('ANTHERC0DE00', 'other', sig) })).status).toBe(
      401,
    );

    const loginNonce = await challenge('login');
    const sig2 = await device.sign(authSigningMessage('register', loginNonce, device.publicKey));
    expect(
      (await api('/auth/register', { body: body('ANTHERC0DE00', 'other', sig2, loginNonce) }))
        .status,
    ).toBe(401);
  });

  it('validates input without echoing it back', async () => {
    const res = await api('/auth/register', { body: { username: '<script>', inviteCode: 'x' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).not.toContain('<script>');
  });

  it('reports username availability', async () => {
    await registerUser();
    expect((await api('/auth/username/maya')).json).toMatchObject({ available: false });
    expect((await api('/auth/username/newname')).json).toEqual({ available: true });
    expect((await api('/auth/username/Bad!')).json.available).toBe(false);
  });
});

describe('login and sessions', () => {
  it('signs in with the device key and replaces the previous session', async () => {
    const { session, device } = await registerUser();
    const res = await login(session.deviceId, device);
    expect(res.status).toBe(200);
    const next = AuthSession.parse(res.json);
    expect(next.user.id).toBe(session.user.id);

    // The older session is revoked: its access and refresh tokens stop working.
    expect((await api('/me', { token: session.accessToken })).status).toBe(401);
    expect(
      (await api('/auth/refresh', { body: { refreshToken: session.refreshToken } })).status,
    ).toBe(401);
    expect((await api('/me', { token: next.accessToken })).status).toBe(200);
  });

  it('rejects login signed by another key', async () => {
    const { session } = await registerUser();
    expect((await login(session.deviceId, await newDevice())).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the session on reuse', async () => {
    const { session } = await registerUser();
    const first = await api('/auth/refresh', { body: { refreshToken: session.refreshToken } });
    expect(first.status).toBe(200);
    const pair = TokenPair.parse(first.json);
    expect(pair.refreshToken).not.toBe(session.refreshToken);

    // Replaying the old token looks like theft: the whole session is killed.
    expect(
      (await api('/auth/refresh', { body: { refreshToken: session.refreshToken } })).status,
    ).toBe(401);
    expect((await api('/auth/refresh', { body: { refreshToken: pair.refreshToken } })).status).toBe(
      401,
    );
    expect((await api('/me', { token: pair.accessToken })).status).toBe(401);

    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE event = 'refresh_token_reuse'",
    ).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('rejects missing, malformed and forged access tokens', async () => {
    const { session } = await registerUser();
    expect((await api('/me')).status).toBe(401);
    expect((await api('/me', { token: 'not-a-jwt' })).status).toBe(401);
    const [h, p] = session.accessToken.split('.');
    expect((await api('/me', { token: `${h}.${p}.forgedsignature` })).status).toBe(401);
    const none = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' })).replace(/=+$/, '');
    expect((await api('/me', { token: `${none}.${p}.` })).status).toBe(401);
  });

  it('logout removes the device: tokens and the device key stop working', async () => {
    const { session, device } = await registerUser();
    expect((await api('/auth/logout', { body: {}, token: session.accessToken })).status).toBe(200);
    expect((await api('/me', { token: session.accessToken })).status).toBe(401);
    expect(
      (await api('/auth/refresh', { body: { refreshToken: session.refreshToken } })).status,
    ).toBe(401);
    expect((await login(session.deviceId, device)).status).toBe(401);
  });
});

describe('account recovery', () => {
  const recover = async (username: string, recoveryKey: string) => {
    const device = await newDevice();
    const nonce = await challenge('recover');
    return api('/auth/recover', {
      body: {
        username,
        recoveryKey,
        device: { name: 'New phone', platform: 'ios', signingPublicKey: device.publicKey },
        nonce,
        signature: await device.sign(authSigningMessage('recover', nonce, device.publicKey)),
      },
    });
  };

  it('enrols a new device with the recovery key', async () => {
    const { session } = await registerUser();
    const res = await recover('maya', 'p4y9 8rjr k0xw tx0y kb7t v8dc');
    expect(res.status).toBe(201);
    expect(res.json.user.id).toBe(session.user.id);
    expect(res.json.deviceId).not.toBe(session.deviceId);
  });

  it('gives the same answer for a wrong key and an unknown user', async () => {
    await registerUser();
    const wrong = await recover('maya', 'ZZZZZZZZZZZZZZZZZZZZZZZZ');
    const unknown = await recover('nobody', RECOVERY_KEY);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.error.message).toBe(unknown.json.error.message);
  });

  it('accepts only the newest key after rotation', async () => {
    const { session } = await registerUser();
    const fresh = 'NEWKEY0000000000000000AB';
    expect(
      (
        await api('/me/recovery-key', {
          method: 'PUT',
          body: { recoveryKey: fresh },
          token: session.accessToken,
        })
      ).status,
    ).toBe(200);
    expect((await recover('maya', RECOVERY_KEY)).status).toBe(401);
    expect((await recover('maya', fresh)).status).toBe(201);
  });
});

describe('profile', () => {
  it('updates name and about with validation', async () => {
    const { session } = await registerUser();
    const res = await api('/me', {
      method: 'PATCH',
      body: { displayName: '  Maya C.  ', about: 'Hiking' },
      token: session.accessToken,
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ displayName: 'Maya C.', about: 'Hiking' });
    expect(
      (
        await api('/me', {
          method: 'PATCH',
          body: { displayName: 'evil‮name' },
          token: session.accessToken,
        })
      ).status,
    ).toBe(400);
    expect(
      (await api('/me', { method: 'PATCH', body: {}, token: session.accessToken })).status,
    ).toBe(400);
  });
});

describe('devices', () => {
  it('lists, renames and revokes own devices only', async () => {
    const { session } = await registerUser();
    const phone2 = await (async () => {
      const device = await newDevice();
      const nonce = await challenge('recover');
      const res = await api('/auth/recover', {
        body: {
          username: 'maya',
          recoveryKey: RECOVERY_KEY,
          device: { name: 'iPad', platform: 'ios', signingPublicKey: device.publicKey },
          nonce,
          signature: await device.sign(authSigningMessage('recover', nonce, device.publicKey)),
        },
      });
      return AuthSession.parse(res.json);
    })();

    const list = await api('/devices', { token: session.accessToken });
    expect(list.json.devices).toHaveLength(2);
    expect(list.json.devices.find((d: { current: boolean }) => d.current).id).toBe(
      session.deviceId,
    );

    expect(
      (
        await api(`/devices/${phone2.deviceId}`, {
          method: 'PATCH',
          body: { name: 'Kitchen iPad' },
          token: session.accessToken,
        })
      ).status,
    ).toBe(200);
    expect(
      (await api(`/devices/${phone2.deviceId}`, { method: 'DELETE', token: session.accessToken }))
        .status,
    ).toBe(200);
    expect((await api('/me', { token: phone2.accessToken })).status).toBe(401);

    // Another account cannot see or touch these devices.
    await seedInvite('0THERVSER000');
    const other = await registerUser({ inviteCode: '0THERVSER000', username: 'dan' });
    expect(
      (
        await api(`/devices/${session.deviceId}`, {
          method: 'DELETE',
          token: other.session.accessToken,
        })
      ).status,
    ).toBe(404);
    expect((await api('/me', { token: session.accessToken })).status).toBe(200);
  });
});

describe('invites', () => {
  it('creates, previews, redeems and revokes invites', async () => {
    const { session } = await registerUser();
    const created = await api('/invites', {
      body: { expiresInDays: 3 },
      token: session.accessToken,
    });
    expect(created.status).toBe(201);
    expect(created.json.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);

    const preview = await api(`/invites/preview?code=${created.json.code}`);
    expect(preview.json.inviterName).toBe('Maya Chen');
    expect((await api('/invites/preview?code=ZZZZZZZZZZZZ')).status).toBe(404);

    const joined = await registerUser({ inviteCode: created.json.code, username: 'dan' });
    expect(joined.status).toBe(201);
    const invitedBy = await env.DB.prepare('SELECT invited_by, role FROM users WHERE username = ?')
      .bind('dan')
      .first();
    expect(invitedBy).toEqual({ invited_by: session.user.id, role: 'member' });

    const second = await api('/invites', { body: {}, token: session.accessToken });
    expect((await api('/invites', { token: session.accessToken })).json.invites).toHaveLength(1);
    expect(
      (await api(`/invites/${second.json.id}`, { method: 'DELETE', token: session.accessToken }))
        .status,
    ).toBe(200);
    expect((await api(`/invites/preview?code=${second.json.code}`)).status).toBe(404);
  });

  it('caps open invites per person', async () => {
    const { session } = await registerUser();
    for (let i = 0; i < 10; i++)
      expect((await api('/invites', { body: {}, token: session.accessToken })).status).toBe(201);
    expect((await api('/invites', { body: {}, token: session.accessToken })).status).toBe(429);
  });
});

describe('rate limiting', () => {
  it('throttles repeated registration attempts', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await registerUser({ inviteCode: 'ZZZZZZZZZZZZ' })).status);
    expect(statuses.slice(0, 5).every((s) => s === 403)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('stores only hashed client identifiers', async () => {
    await challenge('login');
    const { results } = await env.DB.prepare('SELECT key FROM rate_limits').all<{ key: string }>();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.key).toMatch(/^[a-z-]+:[0-9a-f]{32}$/);
  });
});
