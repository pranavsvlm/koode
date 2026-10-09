import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { apiRequest } from '@/lib/api';
import { createAuthClient } from './client';
import { keystore } from './keystore';

/** App-wide auth client wired to the real API, Keychain and CSPRNG. */
export const authClient = createAuthClient({
  request: apiRequest,
  keystore,
  randomBytes: Crypto.getRandomBytes,
  deviceInfo: () => ({
    name: (Constants.deviceName || (Platform.OS === 'ios' ? 'iPhone' : 'Android phone')).slice(
      0,
      64,
    ),
    platform: Platform.OS === 'android' ? 'android' : 'ios',
  }),
});

export { SignedOutError } from './client';
