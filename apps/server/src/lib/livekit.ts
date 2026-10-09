import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { ApiError } from './errors';

/**
 * A LiveKit join token for exactly one room and one identity. Signed here
 * with the API secret, which never leaves the server. Short-lived: it only
 * needs to be valid at join time; LiveKit keeps the session alive after.
 */
export async function mediaToken(
  env: Env,
  opts: { room: string; identity: string; name: string },
): Promise<{ url: string; token: string }> {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new ApiError('internal', 'Calling isn’t configured on this server');
  }
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: opts.identity,
    name: opts.name,
    ttl: '10m',
  });
  at.addGrant({
    room: opts.room,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    // Audio and camera only: no screen share, no data channel.
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  return { url: env.LIVEKIT_URL, token: await at.toJwt() };
}
