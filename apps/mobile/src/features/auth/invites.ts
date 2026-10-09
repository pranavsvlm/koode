import { formatInviteCode } from '@koode/shared';
import { Share } from 'react-native';

export function shareInvite(code: string) {
  return Share.share({
    message: `Join me on Koode, our private family chat. Your invite code: ${formatInviteCode(code)}`,
  });
}
