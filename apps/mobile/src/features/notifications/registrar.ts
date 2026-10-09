import type { PushRegistration, PushSettings } from '@koode/shared';
import { buildRegistration, type DeviceTokens } from './policy';

export type RegistrarDeps = {
  tokens: () => Promise<DeviceTokens>;
  settings: () => PushSettings;
  put: (registration: PushRegistration) => Promise<unknown>;
  remove: () => Promise<unknown>;
};

/**
 * Keeps the server's push registration for this device in step with its
 * tokens and notification settings. Calls are serialized and only sent when
 * something changed; a failed send is retried on the next sync.
 */
export function createRegistrar(deps: RegistrarDeps) {
  let sent: string | null = null; // JSON of the last registration the server accepted
  let running: Promise<void> | null = null;
  let again = false;

  async function once() {
    const registration = buildRegistration(await deps.tokens(), deps.settings());
    const key = JSON.stringify(registration);
    if (key === sent) return;
    if (registration) await deps.put(registration);
    else if (sent !== null) await deps.remove();
    sent = key;
  }

  async function loop() {
    do {
      again = false;
      await once();
    } while (again);
  }

  return {
    sync(): Promise<void> {
      if (running) {
        again = true;
        return running;
      }
      running = loop().finally(() => {
        running = null;
      });
      return running;
    },
    /** Forget what was sent (after sign-out the server deletes the registration). */
    reset() {
      sent = null;
    },
  };
}
