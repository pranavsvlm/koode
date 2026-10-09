import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';

/**
 * Accepts APNs pushes from the Koode Worker over HTTP/1.1 and forwards them
 * to APNs over HTTP/2.
 *
 * Modes:
 *  - `apns`: real APNs. Needs the .p8 signing key from the Apple Developer account.
 *  - `simulator`: development. Alert pushes go to a booted iOS Simulator via
 *    `xcrun simctl push`; VoIP pushes are logged and dropped (the Simulator has
 *    no PushKit).
 *
 * Logs never include tokens or payloads.
 */

export type RelayConfig = {
  /** Shared with the Worker (`PUSH_RELAY_SECRET`); at least 32 characters. */
  secret: string;
  mode: 'apns' | 'simulator';
  apns?: {
    keyId: string;
    teamId: string;
    /** PEM contents of the AuthKey_XXXX.p8 file. */
    key: string;
    /** Overridable for tests. */
    hosts?: { sandbox: string; production: string };
  };
  /** Simulator mode: `simctl` device (UDID or "booted"). */
  simulator?: string;
  /** Simulator mode: replaces `xcrun simctl push` (tests). */
  simulatorPush?: (device: string, topic: string, payload: string) => Promise<void>;
  log?: (line: Record<string, unknown>) => void;
};

export type RelayPush = {
  token: string;
  topic: string;
  environment: 'sandbox' | 'production';
  pushType: 'alert' | 'voip';
  priority: 10 | 5;
  expiration: number;
  collapseId?: string;
  payload: Record<string, unknown>;
};

/** What APNs said (status 200 = accepted). */
export type RelayResult = { status: number; reason?: string };

const MAX_BODY = 8 * 1024;
const APNS_HOSTS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};
/** Apple rejects provider tokens older than an hour and throttles refreshes faster than 20 min. */
const TOKEN_TTL_MS = 40 * 60_000;

function parsePush(raw: unknown): RelayPush | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const ok =
    typeof p.token === 'string' &&
    /^[0-9a-f]{64,200}$/i.test(p.token) &&
    typeof p.topic === 'string' &&
    /^[A-Za-z0-9.-]{3,160}$/.test(p.topic) &&
    (p.environment === 'sandbox' || p.environment === 'production') &&
    (p.pushType === 'alert' || p.pushType === 'voip') &&
    (p.priority === 10 || p.priority === 5) &&
    typeof p.expiration === 'number' &&
    (p.collapseId === undefined ||
      (typeof p.collapseId === 'string' && p.collapseId.length <= 64)) &&
    !!p.payload &&
    typeof p.payload === 'object';
  return ok ? (p as unknown as RelayPush) : null;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // Past the limit, keep draining (so we can still answer 413) but stop storing.
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function secretMatches(header: string | undefined, secret: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const defaultSimulatorPush = (device: string, topic: string, payload: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn('xcrun', ['simctl', 'push', device, topic, '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `simctl exited ${code}`)),
    );
    child.stdin.end(payload);
  });

export function createRelay(config: RelayConfig): Server {
  if (config.secret.length < 32) throw new Error('RELAY_SECRET must be at least 32 characters');
  if (config.mode === 'apns' && !(config.apns?.keyId && config.apns.teamId && config.apns.key))
    throw new Error('APNs mode needs APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY_FILE');
  const log = config.log ?? ((line) => console.log(JSON.stringify(line)));

  // ——— APNs ———
  let providerToken: { jwt: string; at: number } | null = null;
  const sessions = new Map<string, ClientHttp2Session>();

  async function bearer(): Promise<string> {
    const apns = config.apns!;
    if (providerToken && Date.now() - providerToken.at < TOKEN_TTL_MS) return providerToken.jwt;
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: apns.keyId })
      .setIssuer(apns.teamId)
      .setIssuedAt()
      .sign(await importPKCS8(apns.key, 'ES256'));
    providerToken = { jwt, at: Date.now() };
    return jwt;
  }

  function session(origin: string): ClientHttp2Session {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(origin);
    s.on('error', () => sessions.delete(origin));
    s.on('close', () => sessions.delete(origin));
    sessions.set(origin, s);
    return s;
  }

  async function sendApns(push: RelayPush): Promise<RelayResult> {
    const origin = (config.apns!.hosts ?? APNS_HOSTS)[push.environment];
    const headers: Record<string, string | number> = {
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${push.token}`,
      authorization: `bearer ${await bearer()}`,
      'apns-topic': push.topic,
      'apns-push-type': push.pushType,
      'apns-priority': push.priority,
      'apns-expiration': push.expiration,
      'content-type': 'application/json',
    };
    if (push.collapseId) headers['apns-collapse-id'] = push.collapseId;
    const body = JSON.stringify(push.payload);
    return new Promise((resolve, reject) => {
      const req = session(origin).request(headers);
      let status = 0;
      let data = '';
      req.setEncoding('utf8');
      req.on('response', (h) => (status = Number(h[constants.HTTP2_HEADER_STATUS])));
      req.on('data', (d: string) => (data += d));
      req.on('end', () => {
        let reason: string | undefined;
        try {
          reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
        } catch {
          reason = undefined;
        }
        if (reason === 'ExpiredProviderToken') providerToken = null;
        resolve({ status, reason });
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  // ——— Simulator ———
  async function sendSimulator(push: RelayPush): Promise<RelayResult> {
    if (push.pushType === 'voip') return { status: 200, reason: 'SimulatorDroppedVoip' };
    const deliver = config.simulatorPush ?? defaultSimulatorPush;
    // simctl needs the target bundle id in the payload when one isn't given; we pass it.
    await deliver(config.simulator ?? 'booted', push.topic, JSON.stringify(push.payload));
    return { status: 200 };
  }

  const server = createServer(async (req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health')
        return reply(200, { ok: true, mode: config.mode });
      if (req.method !== 'POST' || req.url !== '/apns') return reply(404, { error: 'not_found' });
      if (!secretMatches(req.headers.authorization, config.secret))
        return reply(401, { error: 'unauthorized' });
      const raw = await readBody(req);
      if (raw === null) return reply(413, { error: 'too_large' });
      let push: RelayPush | null = null;
      try {
        push = parsePush(JSON.parse(raw));
      } catch {
        push = null;
      }
      if (!push) return reply(400, { error: 'bad_request' });
      const started = Date.now();
      const result = config.mode === 'apns' ? await sendApns(push) : await sendSimulator(push);
      log({
        type: 'apns',
        mode: config.mode,
        pushType: push.pushType,
        environment: push.environment,
        status: result.status,
        reason: result.reason,
        ms: Date.now() - started,
      });
      return reply(200, result);
    } catch (e) {
      log({ type: 'apns_error', message: e instanceof Error ? e.message : String(e) });
      return reply(502, { error: 'upstream' });
    }
  });
  server.on('close', () => sessions.forEach((s) => s.close()));
  return server;
}
