import { DEFAULT_PREFERENCES } from '@/stores/preferences';
import {
  ACTION,
  buildRegistration,
  foregroundBehavior,
  parsePushData,
  pushSettings,
  tapAction,
  type DeviceTokens,
} from '../policy';

const message = { type: 'message', conversationId: 'cnv_1', messageId: 'm1' };
const call = {
  type: 'call',
  callId: 'cal_1',
  callerId: 'usr_m',
  callerName: 'Maya',
  kind: 'video',
};
const missed = { type: 'missed-call', callId: 'cal_1', callerId: 'usr_m' };
const ctx = { viewingConversationId: null, inAppSounds: true };

describe('parsePushData', () => {
  it('accepts Koode payloads and rejects anything else', () => {
    expect(parsePushData(message)).toEqual(message);
    expect(parsePushData({ type: 'message' })).toBeNull();
    expect(parsePushData(null)).toBeNull();
    expect(parsePushData('x')).toBeNull();
  });
});

describe('foregroundBehavior', () => {
  it('shows messages unless that chat is on screen', () => {
    expect(foregroundBehavior(message, ctx)).toMatchObject({
      shouldShowBanner: true,
      shouldPlaySound: true,
    });
    expect(foregroundBehavior(message, { ...ctx, inAppSounds: false }).shouldPlaySound).toBe(false);
    expect(foregroundBehavior(message, { ...ctx, viewingConversationId: 'cnv_1' })).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  it('never shows ringing (the in-app screen does) and lists missed calls quietly', () => {
    expect(foregroundBehavior(call, ctx).shouldShowBanner).toBe(false);
    expect(foregroundBehavior({ type: 'call-ended', callId: 'c' }, ctx).shouldShowList).toBe(false);
    expect(foregroundBehavior(missed, ctx)).toMatchObject({
      shouldShowBanner: false,
      shouldShowList: true,
    });
  });
});

describe('tapAction', () => {
  const tap = 'expo.modules.notifications.actions.DEFAULT';
  it('routes each notification type', () => {
    expect(tapAction(message, tap)).toEqual({ kind: 'chat', conversationId: 'cnv_1' });
    expect(tapAction(missed, tap)).toEqual({ kind: 'calls' });
    expect(tapAction(missed, ACTION.callBack)).toEqual({ kind: 'call-back', userId: 'usr_m' });
    expect(tapAction(call, tap)).toEqual({ kind: 'incoming-call', callId: 'cal_1', answer: false });
    expect(tapAction(call, ACTION.answer)).toEqual({
      kind: 'incoming-call',
      callId: 'cal_1',
      answer: true,
    });
    expect(tapAction(call, ACTION.decline)).toEqual({ kind: 'decline-call', callId: 'cal_1' });
    expect(tapAction({ foo: 1 }, tap)).toBeNull();
  });
});

describe('registration', () => {
  const ios: DeviceTokens = {
    platform: 'ios',
    appId: 'com.navoasis.koode.dev',
    environment: 'sandbox',
    alertToken: 'a'.repeat(64),
    voipToken: null,
  };

  it('maps preferences to server settings', () => {
    expect(pushSettings(DEFAULT_PREFERENCES)).toEqual({
      directMessages: true,
      groupMessages: true,
      calls: true,
      previews: true,
    });
    expect(pushSettings({ ...DEFAULT_PREFERENCES, notificationPreview: 'never' }).previews).toBe(
      false,
    );
  });

  it('registers whatever tokens exist, or nothing', () => {
    const s = pushSettings(DEFAULT_PREFERENCES);
    expect(buildRegistration(ios, s)).toMatchObject({
      platform: 'ios',
      alertToken: ios.alertToken,
      voipToken: null,
    });
    // Calls still ring through PushKit when alerts are off.
    expect(
      buildRegistration({ ...ios, alertToken: null, voipToken: 'b'.repeat(64) }, s),
    ).toMatchObject({
      alertToken: null,
      voipToken: 'b'.repeat(64),
    });
    expect(buildRegistration({ ...ios, alertToken: null }, s)).toBeNull();
    expect(buildRegistration({ ...ios, platform: 'android', alertToken: 'fcm' }, s)).toEqual({
      platform: 'android',
      appId: ios.appId,
      alertToken: 'fcm',
      settings: s,
    });
  });
});
