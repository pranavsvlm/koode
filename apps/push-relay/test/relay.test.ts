import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from 'node:http2';
import type { Server } from 'node:http';
import { importSPKI, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRelay, type RelayPush } from '../src/relay.ts';

const SECRET = 'relay-test-secret-0123456789abcdefghij';
const TOKEN = 'a'.repeat(64);

const listen = (s: Server | Http2Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const close = (s: Server | Http2Server) => new Promise((r) => s.close(r));

const push = (patch: Partial<RelayPush> = {}): RelayPush => ({
  token: TOKEN,
  topic: 'com.example.app',
  environment: 'sandbox',
  pushType: 'alert',
  priority: 10,
  expiration: 0,
  payload: { aps: { alert: { title: 't', body: 'b' } } },
  ...patch,
});

async function post(port: number, body: unknown, secret = SECRET) {
  const res = await fetch(`http://127.0.0.1:${port}/apns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('APNs mode (against a local HTTP/2 APNs stand-in)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spki = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  let apns: Http2Server;
  let relay: Server;
  let relayPort: number;
  let seen: { headers: IncomingHttpHeaders; body: string }[];
  let respond: (headers: IncomingHttpHeaders) => { status: number; body?: unknown };

  beforeEach(async () => {
    seen = [];
    respond = () => ({ status: 200 });
    apns = createServer();
    apns.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (d: string) => (body += d));
      stream.on('end', () => {
        seen.push({ headers, body });
        const r = respond(headers);
        stream.respond({ ':status': r.status, 'content-type': 'application/json' });
        stream.end(r.body ? JSON.stringify(r.body) : '');
      });
    });
    const apnsPort = await listen(apns);
    const origin = `http://127.0.0.1:${apnsPort}`;
    relay = createRelay({
      secret: SECRET,
      mode: 'apns',
      apns: {
        keyId: 'KEY1234567',
        teamId: 'TEAM123456',
        key: pem,
        hosts: { sandbox: origin, production: origin },
      },
      log: () => {},
    });
    relayPort = await listen(relay);
  });
  afterEach(async () => {
    await close(relay);
    await close(apns);
  });

  it('forwards over HTTP/2 with a valid ES256 provider token and APNs headers', async () => {
    const r = await post(
      relayPort,
      push({
        pushType: 'voip',
        topic: 'com.example.app.voip',
        collapseId: 'cal_1',
        expiration: 123,
      }),
    );
    expect(r).toEqual({ status: 200, body: { status: 200 } });
    const [req] = seen;
    expect(req!.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(req!.headers['apns-topic']).toBe('com.example.app.voip');
    expect(req!.headers['apns-push-type']).toBe('voip');
    expect(req!.headers['apns-priority']).toBe('10');
    expect(req!.headers['apns-expiration']).toBe('123');
    expect(req!.headers['apns-collapse-id']).toBe('cal_1');
    expect(JSON.parse(req!.body)).toEqual(push().payload);

    const jwt = String(req!.headers.authorization).replace(/^bearer /, '');
    const { payload, protectedHeader } = await jwtVerify(jwt, await importSPKI(spki, 'ES256'));
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(payload.iss).toBe('TEAM123456');
    expect(typeof payload.iat).toBe('number');
  });

  it('reuses the provider token and the connection', async () => {
    await post(relayPort, push());
    await post(relayPort, push());
    expect(seen[0]!.headers.authorization).toBe(seen[1]!.headers.authorization);
  });

  it('passes APNs rejections through (the Worker deletes dead tokens)', async () => {
    respond = () => ({ status: 410, body: { reason: 'Unregistered' } });
    expect((await post(relayPort, push())).body).toEqual({ status: 410, reason: 'Unregistered' });
  });

  it('rejects a wrong secret and malformed pushes without contacting APNs', async () => {
    expect((await post(relayPort, push(), 'wrong-secret-wrong-secret-wrong-secret!')).status).toBe(
      401,
    );
    expect((await post(relayPort, push({ token: 'not-hex' }))).status).toBe(400);
    expect((await post(relayPort, push({ pushType: 'background' as never }))).status).toBe(400);
    expect((await post(relayPort, '{not json')).status).toBe(400);
    expect((await post(relayPort, push({ payload: { pad: 'x'.repeat(9000) } }))).status).toBe(413);
    expect(seen).toHaveLength(0);
  });
});

describe('simulator mode', () => {
  let relay: Server;
  let port: number;
  let delivered: [string, string, string][];

  beforeEach(async () => {
    delivered = [];
    relay = createRelay({
      secret: SECRET,
      mode: 'simulator',
      simulator: 'SIM-UDID',
      simulatorPush: async (...a) => void delivered.push(a),
      log: () => {},
    });
    port = await listen(relay);
  });
  afterEach(() => close(relay));

  it('delivers alerts to the Simulator and drops VoIP pushes', async () => {
    expect((await post(port, push())).body).toEqual({ status: 200 });
    expect(delivered).toEqual([['SIM-UDID', 'com.example.app', JSON.stringify(push().payload)]]);
    expect((await post(port, push({ pushType: 'voip' }))).body).toEqual({
      status: 200,
      reason: 'SimulatorDroppedVoip',
    });
    expect(delivered).toHaveLength(1);
  });
});

it('refuses weak secrets and missing APNs credentials', () => {
  expect(() => createRelay({ secret: 'short', mode: 'simulator' })).toThrow();
  expect(() => createRelay({ secret: SECRET, mode: 'apns' })).toThrow();
});
