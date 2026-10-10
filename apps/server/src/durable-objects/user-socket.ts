import { DurableObject } from 'cloudflare:workers';
import { ClientFrame } from '@koode/shared';
import { setPresence } from '../presence';

type Attachment = { userId: string; deviceId: string; activeAt: number };

const PING = JSON.stringify({ type: 'ping' });
const PONG = JSON.stringify({ type: 'pong' });
const MAX_FRAME_BYTES = 2048;
/**
 * Apps ping about every 25 s while running. A connection silent for longer
 * than this belongs to an app that was frozen or lost its network without
 * closing it (iOS freezes background apps): it's closed, and the user shown
 * offline.
 */
export const STALE_AFTER_MS = 75_000;
const SWEEP_EVERY_MS = 30_000;

/**
 * One instance per user: holds the WebSockets of all their devices (with the
 * Hibernation API, so idle connections cost nothing) and delivers events to
 * them. Only reachable through the Worker, which authenticates the upgrade.
 */
export class UserSocket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const userId = request.headers.get('x-koode-user-id');
    const deviceId = request.headers.get('x-koode-device-id');
    if (!userId || !deviceId) return new Response('Unauthenticated', { status: 401 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [deviceId]);
    server.serializeAttachment({ userId, deviceId, activeAt: Date.now() } satisfies Attachment);
    server.send(JSON.stringify({ type: 'ready' }));
    await this.ctx.storage.put('userId', userId);
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY_MS);
    await this.updatePresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES) return;
    const attachment = ws.deserializeAttachment() as Attachment;
    ws.serializeAttachment({ ...attachment, activeAt: Date.now() } satisfies Attachment);
    let frame: ClientFrame;
    try {
      const parsed = ClientFrame.safeParse(JSON.parse(data));
      if (!parsed.success) return;
      frame = parsed.data;
    } catch {
      return;
    }
    if (frame.type === 'ping') {
      ws.send(PONG);
      return;
    }
    const { userId } = ws.deserializeAttachment() as Attachment;
    const room = this.env.CONVERSATION_ROOM.get(
      this.env.CONVERSATION_ROOM.idFromName(frame.conversationId),
    );
    await room.typing({ conversationId: frame.conversationId, userId }).catch(() => {});
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    await this.updatePresence(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.updatePresence(ws);
  }

  /** Close connections that stopped pinging; keep sweeping while any are open. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const { activeAt } = ws.deserializeAttachment() as Attachment;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      if (now - Math.max(activeAt ?? 0, pinged) > STALE_AFTER_MS) {
        try {
          ws.close(4002, 'No heartbeat');
        } catch {
          // already closed
        }
      }
    }
    await this.updatePresence();
    if (this.open().length > 0) await this.ctx.storage.setAlarm(now + SWEEP_EVERY_MS);
  }

  private open(except?: WebSocket) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  /** Online while any device is connected; changes are recorded and published. */
  private async updatePresence(closing?: WebSocket): Promise<void> {
    const userId = await this.ctx.storage.get<string>('userId');
    if (!userId) return;
    const online = this.open(closing).length > 0;
    if ((await this.ctx.storage.get<boolean>('online')) === online) return;
    await this.ctx.storage.put('online', online);
    await setPresence(this.env, userId, online).catch((e: unknown) =>
      console.error(JSON.stringify({ type: 'presence_error', message: String(e) })),
    );
  }

  /** Send a pre-serialised event to every connected device of this user. */
  async deliver(payload: string): Promise<number> {
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
        sent++;
      } catch {
        // socket going away
      }
    }
    return sent;
  }

  /** Close a removed or signed-out device's connections. */
  async disconnectDevice(deviceId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(deviceId)) {
      try {
        ws.close(4001, 'Device signed out');
      } catch {
        // already closed
      }
    }
    await this.updatePresence();
  }

  /** Number of open connections (tests and diagnostics). */
  async connectionCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }
}
