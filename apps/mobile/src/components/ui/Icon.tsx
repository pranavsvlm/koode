import { SymbolView, type SymbolViewProps, type SymbolWeight } from 'expo-symbols';
import type { ColorValue, StyleProp, ViewStyle } from 'react-native';
import { useThemeColors } from '@/theme/ThemeProvider';
import type { ColorToken } from '@/theme/tokens';

type SymbolName = Exclude<SymbolViewProps['name'], string>;

/**
 * Semantic icon names → SF Symbols (iOS) and Material Symbols (Android).
 * Screens use these names only, so the icon language stays consistent.
 */
export const ICONS = {
  chats: { ios: 'bubble.left.and.bubble.right.fill', android: 'chat' },
  calls: { ios: 'phone.fill', android: 'call' },
  contacts: { ios: 'person.2.fill', android: 'group' },
  settings: { ios: 'gearshape.fill', android: 'settings' },
  search: { ios: 'magnifyingglass', android: 'search' },
  compose: { ios: 'square.and.pencil', android: 'edit_square' },
  phone: { ios: 'phone.fill', android: 'call' },
  video: { ios: 'video.fill', android: 'videocam' },
  'video-off': { ios: 'video.slash.fill', android: 'videocam_off' },
  mic: { ios: 'mic.fill', android: 'mic' },
  'mic-off': { ios: 'mic.slash.fill', android: 'mic_off' },
  speaker: { ios: 'speaker.wave.2.fill', android: 'volume_up' },
  'camera-flip': { ios: 'arrow.triangle.2.circlepath.camera.fill', android: 'flip_camera_ios' },
  'end-call': { ios: 'phone.down.fill', android: 'call_end' },
  'incoming-call': { ios: 'phone.arrow.down.left', android: 'call_received' },
  'outgoing-call': { ios: 'phone.arrow.up.right', android: 'call_made' },
  'missed-call': { ios: 'phone.arrow.down.left', android: 'call_missed' },
  plus: { ios: 'plus', android: 'add' },
  send: { ios: 'arrow.up', android: 'arrow_upward' },
  waveform: { ios: 'waveform', android: 'graphic_eq' },
  'chevron-right': { ios: 'chevron.right', android: 'chevron_right' },
  'chevron-down': { ios: 'chevron.down', android: 'expand_more' },
  check: { ios: 'checkmark', android: 'check' },
  'check-circle': { ios: 'checkmark.circle.fill', android: 'check_circle' },
  clock: { ios: 'clock', android: 'schedule' },
  lock: { ios: 'lock.fill', android: 'lock' },
  shield: { ios: 'lock.shield.fill', android: 'shield_lock' },
  key: { ios: 'key.fill', android: 'key' },
  bell: { ios: 'bell.fill', android: 'notifications' },
  palette: { ios: 'paintpalette.fill', android: 'palette' },
  person: { ios: 'person.crop.circle.fill', android: 'account_circle' },
  'person-add': { ios: 'person.badge.plus', android: 'person_add' },
  group: { ios: 'person.3.fill', android: 'groups' },
  photo: { ios: 'photo.on.rectangle', android: 'photo_library' },
  camera: { ios: 'camera.fill', android: 'photo_camera' },
  document: { ios: 'doc.fill', android: 'description' },
  reply: { ios: 'arrowshape.turn.up.left.fill', android: 'reply' },
  copy: { ios: 'doc.on.doc', android: 'content_copy' },
  trash: { ios: 'trash', android: 'delete' },
  info: { ios: 'info.circle', android: 'info' },
  close: { ios: 'xmark', android: 'close' },
  more: { ios: 'ellipsis', android: 'more_horiz' },
  share: { ios: 'square.and.arrow.up', android: 'share' },
  download: { ios: 'arrow.down.circle', android: 'download' },
  'face-id': { ios: 'faceid', android: 'fingerprint' },
  eye: { ios: 'eye.fill', android: 'visibility' },
  moon: { ios: 'moon.fill', android: 'dark_mode' },
  'text-size': { ios: 'textformat.size', android: 'format_size' },
  server: { ios: 'server.rack', android: 'dns' },
  sparkles: { ios: 'sparkles', android: 'auto_awesome' },
  message: { ios: 'message.fill', android: 'chat_bubble' },
  'message-off': { ios: 'bell.slash.fill', android: 'notifications_off' },
  smile: { ios: 'face.smiling', android: 'mood' },
  qr: { ios: 'qrcode', android: 'qr_code' },
  link: { ios: 'link', android: 'link' },
  devices: { ios: 'iphone', android: 'smartphone' },
  hand: { ios: 'hand.raised.fill', android: 'block' },
  play: { ios: 'play.fill', android: 'play_arrow' },
  pause: { ios: 'pause.fill', android: 'pause' },
  signal: { ios: 'wifi', android: 'wifi' },
  'signal-weak': { ios: 'wifi.exclamationmark', android: 'wifi_off' },
  edit: { ios: 'pencil', android: 'edit' },
  location: { ios: 'location.fill', android: 'location_on' },
  pin: { ios: 'pin.fill', android: 'push_pin' },
  wave: { ios: 'hand.wave.fill', android: 'waving_hand' },
} as const satisfies Record<string, SymbolName>;

export type IconName = keyof typeof ICONS;

export type IconProps = {
  name: IconName;
  size?: number;
  /** A theme token, or a raw colour for fixed-palette surfaces like call screens. */
  color?: ColorToken | ColorValue;
  weight?: SymbolWeight;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

export function Icon({
  name,
  size = 22,
  color = 'text',
  weight = 'medium',
  style,
  accessibilityLabel,
}: IconProps) {
  const colors = useThemeColors();
  const tint = typeof color === 'string' && color in colors ? colors[color as ColorToken] : color;
  return (
    <SymbolView
      name={ICONS[name]}
      size={size}
      tintColor={tint}
      weight={weight}
      style={[{ width: size, height: size }, style]}
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
