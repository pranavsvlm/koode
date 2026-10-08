import { DurableObject } from 'cloudflare:workers';
import { errorBody } from '../lib/errors';

/**
 * One instance per conversation. Coordinates real-time delivery (WebSocket
 * fan-out, typing indicators, receipts) using the WebSocket Hibernation API.
 *
 * Phase 1 registers the class and its SQLite storage so the binding and
 * migration exist; the real-time protocol is implemented in Phase 4.
 */
export class ConversationRoom extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return Response.json(errorBody('not_implemented', 'Real-time messaging arrives in Phase 4'), {
      status: 501,
    });
  }
}
