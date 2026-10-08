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
  onClose: () => void;
  onReply: (m: Message) => void;
  onReact: (m: Message, emoji: string) => void;
  onDelete: (m: Message) => void;
};

/** Long-press menu: quick reactions on top, actions below. */
export function MessageActionsSheet({ message, onClose, onReply, onReact, onDelete }: Props) {
  const dialog = useDialog();
  const toast = useToast();
  const mine = message?.senderId === ME;
  const myReaction = message?.reactions.find((r) => r.userIds.includes(ME))?.emoji;

  const actions: {
    icon: IconName;
    label: string;
    destructive?: boolean;
    run: (m: Message) => void;
  }[] = [
    { icon: 'reply', label: 'Reply', run: onReply },
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
    {
      icon: 'trash',
      label: mine ? 'Delete for everyone' : 'Delete for me',
      destructive: true,
      run: async (m: Message) => {
        const ok = await dialog.confirm({
          title: mine ? 'Delete for everyone?' : 'Delete for you?',
          message: mine
            ? 'This message will be removed from the conversation for all members.'
            : 'This message will be removed from this device.',
          confirmLabel: 'Delete',
          destructive: true,
        });
        if (ok) onDelete(m);
      },
    },
  ];

  return (
    <Sheet visible={!!message} onClose={onClose}>
      {message && (
        <View className="gap-4 px-4 pb-2 pt-1">
          <Text variant="footnote" tone="secondary" numberOfLines={2} className="px-2 text-center">
            {messagePreview(message)}
          </Text>
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
