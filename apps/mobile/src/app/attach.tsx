import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { Icon, PressableScale, Text, useToast, type IconName } from '@/components/ui';
import { devImages } from '@/dev/images';
import { haptics } from '@/lib/haptics';
import { useChat } from '@/stores/chat';

const SOURCES: { icon: IconName; label: string; tint: string }[] = [
  { icon: 'camera', label: 'Camera', tint: '#3563F0' },
  { icon: 'photo', label: 'Photos', tint: '#1A9A5C' },
  { icon: 'document', label: 'File', tint: '#E8590C' },
];

/** Attachment picker (native form sheet). Real pickers arrive in Phase 7. */
export default function AttachScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const send = useChat((s) => s.send);
  const toast = useToast();
  const recent = Object.values(devImages);

  return (
    <ScrollView
      className="flex-1 bg-surface-raised"
      contentContainerClassName="gap-5 px-4 pb-10 pt-6"
    >
      <View className="flex-row gap-3">
        {SOURCES.map((s) => (
          <PressableScale
            key={s.label}
            onPress={() =>
              toast.show({ title: `${s.label} picker arrives with media support (Phase 7)` })
            }
            accessibilityRole="button"
            accessibilityLabel={s.label}
            className="flex-1 items-center gap-2 rounded-xl bg-fill py-4"
          >
            <View
              className="h-11 w-11 items-center justify-center rounded-full"
              style={{ backgroundColor: s.tint }}
            >
              <Icon name={s.icon} size={20} color="#FFFFFF" />
            </View>
            <Text variant="footnote" className="font-semibold">
              {s.label}
            </Text>
          </PressableScale>
        ))}
      </View>

      <Text variant="footnote" tone="secondary" className="ml-1 font-medium uppercase">
        Recent
      </Text>
      <View className="flex-row flex-wrap gap-1 overflow-hidden rounded-xl">
        {recent.map((img, i) => (
          <Pressable
            key={i}
            onPress={() => {
              haptics.tap();
              send(conversationId, { attachment: { kind: 'image', ...img } });
              router.back();
            }}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Send photo ${i + 1}`}
            style={{ width: '32.6%', aspectRatio: 1 }}
          >
            <Image source={img.source} style={{ flex: 1 }} contentFit="cover" transition={150} />
          </Pressable>
        ))}
      </View>
      <Text variant="footnote" tone="tertiary" className="text-center">
        Sample photos for development. Tap one to send it.
      </Text>
    </ScrollView>
  );
}
