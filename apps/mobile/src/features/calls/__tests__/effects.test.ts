import { callScreenEffects } from '../CallEffects';
import type { CallSnapshot } from '../controller';

jest.mock('../../../../modules/koode-call-ui', () => ({ KoodeCallUI: null }));
jest.mock('../index', () => ({ useCall: jest.fn() }));

const snap = (over: Partial<CallSnapshot>): CallSnapshot =>
  ({
    phase: 'idle',
    kind: 'voice',
    cameraOn: false,
    speakerOn: false,
    ...over,
  }) as CallSnapshot;

describe('callScreenEffects', () => {
  it('keeps the screen awake while ringing and during a call, not after', () => {
    for (const phase of [
      'incoming',
      'outgoing',
      'connecting',
      'connected',
      'reconnecting',
    ] as const)
      expect(callScreenEffects(snap({ phase })).keepAwake).toBe(true);
    for (const phase of ['idle', 'ended'] as const)
      expect(callScreenEffects(snap({ phase })).keepAwake).toBe(false);
  });

  it('uses the proximity sensor only for voice on the earpiece', () => {
    expect(callScreenEffects(snap({ phase: 'connected' })).proximity).toBe(true);
    expect(callScreenEffects(snap({ phase: 'connected', speakerOn: true })).proximity).toBe(false);
    expect(
      callScreenEffects(snap({ phase: 'connected', kind: 'video', cameraOn: true })).proximity,
    ).toBe(false);
    // Turning the camera on in a voice call counts as video.
    expect(callScreenEffects(snap({ phase: 'connected', cameraOn: true })).proximity).toBe(false);
    expect(callScreenEffects(snap({ phase: 'incoming' })).proximity).toBe(false);
  });

  it('floats only a connected video call', () => {
    expect(callScreenEffects(snap({ phase: 'connected', kind: 'video' })).pictureInPicture).toBe(
      true,
    );
    expect(callScreenEffects(snap({ phase: 'reconnecting', kind: 'video' })).pictureInPicture).toBe(
      true,
    );
    expect(callScreenEffects(snap({ phase: 'outgoing', kind: 'video' })).pictureInPicture).toBe(
      false,
    );
    expect(callScreenEffects(snap({ phase: 'connected' })).pictureInPicture).toBe(false);
  });
});
