import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect } from 'react';
import { KoodeCallUI } from '../../../modules/koode-call-ui';
import type { CallSnapshot } from './controller';
import { useCall } from './index';

const KEEP_AWAKE_TAG = 'koode-call';

const ringingOrLive = (s: CallSnapshot) =>
  s.phase === 'incoming' ||
  s.phase === 'outgoing' ||
  s.phase === 'connecting' ||
  s.phase === 'connected' ||
  s.phase === 'reconnecting';

const live = (s: CallSnapshot) =>
  s.phase === 'outgoing' ||
  s.phase === 'connecting' ||
  s.phase === 'connected' ||
  s.phase === 'reconnecting';

/** What the screen should do for the current call (pure, for tests). */
export function callScreenEffects(s: CallSnapshot) {
  const video = s.kind === 'video' || s.cameraOn;
  return {
    // The screen never dims or locks during a call.
    keepAwake: ringingOrLive(s),
    // Held to the ear (voice, earpiece): the proximity sensor turns the screen
    // off so a cheek can't press buttons.
    proximity: live(s) && !video && !s.speakerOn,
    // Android: a video call floats when you leave the app.
    pictureInPicture: (s.phase === 'connected' || s.phase === 'reconnecting') && video,
  };
}

/** Screen behaviour during calls. Mounted once at the root. */
export function CallEffects() {
  const s = useCall();
  const { keepAwake, proximity, pictureInPicture } = callScreenEffects(s);

  useEffect(() => {
    if (!keepAwake) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
  }, [keepAwake]);

  useEffect(() => {
    if (!proximity) return;
    void KoodeCallUI?.setProximity(true).catch(() => {});
    return () => void KoodeCallUI?.setProximity(false).catch(() => {});
  }, [proximity]);

  useEffect(() => {
    if (!pictureInPicture) return;
    void KoodeCallUI?.setPictureInPicture(true, 9, 16).catch(() => {});
    return () => void KoodeCallUI?.setPictureInPicture(false, 9, 16).catch(() => {});
  }, [pictureInPicture]);

  return null;
}
