import { DurableObject } from 'cloudflare:workers';
import { ClientFrame } from '@koode/shared';

type Attachment = { userId: string; deviceId: string };

const PING = JSON.stringify({ type: 'ping' });
const PONG = JSON.stringify({ type: 'pong' });
const MAX_FRAME_BYTES = 2048;

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
    server.serializeAttachment({ userId, deviceId } satisfies Attachment);
    server.send(JSON.stringify({ type: 'ready' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES) return;
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
  }

  /** Number of open connections (tests and diagnostics). */
  async connectionCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }
}
