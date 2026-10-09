import { DurableObject } from 'cloudflare:workers';
import { publishCall } from '../calls/events';
import { toCall, transition } from '../calls/rows';

/**
 * One instance per ringing call: an alarm at the ring timeout marks the call
 * missed and sends the missed-call notification, even if the caller's app
 * vanished without hanging up.
 */
export class CallTimer extends DurableObject<Env> {
  async arm(callId: string, at: number): Promise<void> {
    await this.ctx.storage.put('callId', callId);
    await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const callId = await this.ctx.storage.get<string>('callId');
    await this.ctx.storage.deleteAll();
    if (!callId) return;
    const row = await transition(this.env.DB, callId, ['ringing'], 'missed', 'ended');
    if (row) await publishCall(this.env, toCall(row), { wasRinging: true });
  }
}
