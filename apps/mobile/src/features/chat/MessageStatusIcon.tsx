import { View, type ColorValue } from 'react-native';
import { Icon } from '@/components/ui';
import type { MessageStatus } from '@/domain/types';

const LABEL: Record<MessageStatus, string> = {
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Not sent',
};

/** Clock → single tick → double tick → double tick (highlighted) for read. */
export function MessageStatusIcon({
  status,
  color,
  readColor,
}: {
  status: MessageStatus;
  color: ColorValue;
  readColor: ColorValue;
}) {
  const label = LABEL[status];
  if (status === 'sending')
    return <Icon name="clock" size={11} color={color} accessibilityLabel={label} />;
  if (status === 'failed')
    return <Icon name="info" size={13} color="danger" accessibilityLabel={label} />;
  const tint = status === 'read' ? readColor : color;
  return (
    <View
      accessible
      accessibilityLabel={label}
      className="h-3 flex-row items-center"
      style={{ width: status === 'sent' ? 12 : 17 }}
    >
      <Icon name="check" size={12} color={tint} weight="bold" />
      {status !== 'sent' && (
        <Icon
          name="check"
          size={12}
          color={tint}
          weight="bold"
          style={{ position: 'absolute', left: 5 }}
        />
      )}
    </View>
  );
}

export const statusLabel = (s: MessageStatus) => LABEL[s];
