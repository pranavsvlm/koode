import * as Clipboard from 'expo-clipboard';
import { Pressable, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { Icon, Sheet, Text, useDialog, useToast, type IconName } from '@/components/ui';
import { ME, QUICK_REACTIONS, type Message } from '@/domain/types';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import { messagePreview } from '@/stores/chat';

type Props = {
  message: Message | null;
  /** Sender, or a group admin, of a message that was sent. */
  canDeleteForEveryone: boolean;
  onClose: () => void;
  onReply: (m: Message) => void;
  onReact: (m: Message, emoji: string) => void;
  onDelete: (m: Message, scope: 'me' | 'everyone') => void;
  onSave: (m: Message) => void;
  onShare: (m: Message) => void;
};

type Action = {
  icon: IconName;
  label: string;
  destructive?: boolean;
  run: (m: Message) => void;
};

/** Long-press menu: quick reactions on top, actions below. */
export function MessageActionsSheet({
  message,
  canDeleteForEveryone,
  onClose,
  onReply,
  onReact,
  onDelete,
  onSave,
  onShare,
}: Props) {
  const dialog = useDialog();
  const toast = useToast();
  const unsent = message?.status === 'sending' || message?.status === 'failed';
  const myReaction = message?.reactions.find((r) => r.userIds.includes(ME))?.emoji;
  const kind = message?.attachment?.kind;

  const confirmDelete = (scope: 'me' | 'everyone') => async (m: Message) => {
    const ok = await dialog.confirm({
      title: scope === 'everyone' ? 'Delete for everyone?' : 'Delete for you?',
      message:
        scope === 'everyone'
          ? 'The message and any file will be removed for everyone in this conversation.'
          : 'This message will be removed from this device only.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (ok) onDelete(m, scope);
  };

  const actions: Action[] = [
    ...(!unsent ? [{ icon: 'reply' as const, label: 'Reply', run: onReply }] : []),
    ...(message?.text
      ? [
          {
            icon: 'copy' as const,
            label: 'Copy',
            run: async (m: Message) => {
              await Clipboard.setStringAsync(m.text ?? '');
              toast.show({ title: 'Copied', tone: 'success' });
            },
          },
        ]
      : []),
    ...(kind === 'image' || kind === 'video'
      ? [{ icon: 'download' as const, label: 'Save to Photos', run: onSave }]
      : []),
    ...(kind ? [{ icon: 'share' as const, label: 'Share', run: onShare }] : []),
    ...(canDeleteForEveryone && !unsent
      ? [
          {
            icon: 'trash' as const,
            label: 'Delete for Everyone',
            destructive: true,
            run: confirmDelete('everyone'),
          },
        ]
      : []),
    unsent
      ? { icon: 'trash', label: 'Cancel Sending', destructive: true, run: (m) => onDelete(m, 'me') }
      : { icon: 'trash', label: 'Delete for Me', destructive: true, run: confirmDelete('me') },
  ];

  return (
    <Sheet visible={!!message} onClose={onClose}>
      {message && (
        <View className="gap-4 px-4 pb-2 pt-1">
          <Text variant="footnote" tone="secondary" numberOfLines={2} className="px-2 text-center">
            {messagePreview(message)}
          </Text>
          {!unsent && (
            <View className="flex-row justify-between rounded-full bg-fill px-2 py-1.5">
              {QUICK_REACTIONS.map((emoji, i) => (
                <Animated.View
                  key={emoji}
                  entering={ZoomIn.delay(i * 30)
                    .springify()
                    .damping(14)}
                >
                  <Pressable
                    onPress={() => {
                      haptics.selection();
                      onReact(message, emoji);
                      onClose();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`React with ${emoji}`}
                    accessibilityState={{ selected: myReaction === emoji }}
                    className={cn(
                      'h-11 w-11 items-center justify-center rounded-full',
                      myReaction === emoji && 'bg-accent/20',
                    )}
                  >
                    <Text style={{ fontSize: 26, lineHeight: 32 }}>{emoji}</Text>
                  </Pressable>
                </Animated.View>
              ))}
            </View>
          )}
          <View className="overflow-hidden rounded-xl bg-surface">
            {actions.map((a, i) => (
              <Pressable
                key={a.label}
                onPress={() => {
                  onClose();
                  // Let the sheet start closing before any follow-up dialog appears.
                  setTimeout(() => a.run(message), a.destructive ? 260 : 0);
                }}
                accessibilityRole="button"
                className={cn(
                  'h-[52px] flex-row items-center justify-between px-4 active:bg-fill',
                  i > 0 && 'border-t border-separator',
                )}
              >
                <Text variant="body" tone={a.destructive ? 'danger' : 'primary'}>
                  {a.label}
                </Text>
                <Icon name={a.icon} size={18} color={a.destructive ? 'danger' : 'text'} />
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </Sheet>
  );
}
