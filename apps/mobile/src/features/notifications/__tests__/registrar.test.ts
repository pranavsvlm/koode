import type { PushSettings } from '@koode/shared';
import type { DeviceTokens } from '../policy';
import { createRegistrar } from '../registrar';

const settings: PushSettings = {
  directMessages: true,
  groupMessages: true,
  calls: true,
  previews: true,
};

function setup() {
  let tokens: DeviceTokens = {
    platform: 'ios',
    appId: 'app',
    environment: 'sandbox',
    alertToken: 'a'.repeat(64),
    voipToken: null,
  };
  let current = settings;
  const put = jest.fn(async () => {});
  const remove = jest.fn(async () => {});
  const r = createRegistrar({ tokens: async () => tokens, settings: () => current, put, remove });
  return {
    r,
    put,
    remove,
    setTokens: (p: Partial<DeviceTokens>) => (tokens = { ...tokens, ...p }),
    setSettings: (p: Partial<PushSettings>) => (current = { ...current, ...p }),
  };
}

it('sends only when something changed', async () => {
  const t = setup();
  await t.r.sync();
  await t.r.sync();
  expect(t.put).toHaveBeenCalledTimes(1);
  t.setSettings({ previews: false });
  await t.r.sync();
  expect(t.put).toHaveBeenCalledTimes(2);
  expect(t.put).toHaveBeenLastCalledWith(
    expect.objectContaining({ settings: expect.objectContaining({ previews: false }) }),
  );
});

it('serializes overlapping syncs and picks up the latest state', async () => {
  const t = setup();
  const a = t.r.sync();
  t.setTokens({ voipToken: 'b'.repeat(64) });
  const b = t.r.sync();
  await Promise.all([a, b]);
  expect(t.put).toHaveBeenCalledTimes(2);
  expect(t.put).toHaveBeenLastCalledWith(expect.objectContaining({ voipToken: 'b'.repeat(64) }));
});

it('removes the registration when no tokens are left', async () => {
  const t = setup();
  await t.r.sync();
  t.setTokens({ alertToken: null });
  await t.r.sync();
  expect(t.remove).toHaveBeenCalledTimes(1);
});

it('retries after a failure and resends after reset', async () => {
  const t = setup();
  t.put.mockRejectedValueOnce(new Error('offline'));
  await expect(t.r.sync()).rejects.toThrow('offline');
  await t.r.sync();
  expect(t.put).toHaveBeenCalledTimes(2);
  t.r.reset();
  await t.r.sync();
  expect(t.put).toHaveBeenCalledTimes(3);
});
