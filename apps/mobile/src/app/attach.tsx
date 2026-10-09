import { Asset } from 'expo-asset';
import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { Icon, PressableScale, Text, useToast, type IconName } from '@/components/ui';
import { devImages } from '@/dev/images';
import {
  MediaError,
  prepareDocument,
  prepareImage,
  prepareVideo,
  type UploadDraft,
} from '@/features/media/process';
import { haptics } from '@/lib/haptics';
import { useChat } from '@/stores/chat';

type Source = 'camera' | 'photos' | 'file';
const SOURCES: { id: Source; icon: IconName; label: string; tint: string }[] = [
  { id: 'camera', icon: 'camera', label: 'Camera', tint: '#3563F0' },
  { id: 'photos', icon: 'photo', label: 'Photos', tint: '#1A9A5C' },
  { id: 'file', icon: 'document', label: 'File', tint: '#E8590C' },
];

/** Photos and videos from the picker or camera, re-encoded and ready to send. */
async function fromPicker(asset: ImagePicker.ImagePickerAsset): Promise<UploadDraft> {
  if (asset.type === 'video' || asset.type === 'pairedVideo')
    return prepareVideo({
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      durationMs: asset.duration ?? null,
      mimeType: asset.mimeType,
      fileName: asset.fileName,
    });
  return prepareImage({ uri: asset.uri, width: asset.width, height: asset.height });
}

const PICKER: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images', 'videos'],
  quality: 1,
  exif: false,
  // HEIC and other formats arrive as widely readable JPEG / H.264.
  preferredAssetRepresentationMode:
    ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  videoMaxDuration: 600,
};

/** Attachment picker (native form sheet). */
export default function AttachScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const send = useChat((s) => s.send);
  const live = useChat((s) => s.mode === 'live');
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  /** Prepare each file, queue it, close. Files are sent in order by the outbox. */
  const sendAll = async (drafts: (() => Promise<UploadDraft>)[]) => {
    if (drafts.length === 0) return;
    setBusy(true);
    let sent = 0;
    try {
      for (const make of drafts) {
        try {
          send(conversationId, { upload: await make() });
          sent++;
        } catch (e) {
          toast.show({
            title: 'Couldn’t send that file',
            message: e instanceof MediaError ? e.message : 'It couldn’t be read.',
            tone: 'error',
          });
        }
      }
    } finally {
      setBusy(false);
    }
    if (sent > 0) {
      haptics.success();
      router.back();
    }
  };

  const pick = async (source: Source) => {
    if (!live) {
      toast.show({ title: 'Turn off sample data to send real files' });
      return;
    }
    if (source === 'file') {
      const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      if (r.canceled) return;
      return sendAll(
        r.assets.map(
          (a) => () =>
            prepareDocument({ uri: a.uri, name: a.name, mimeType: a.mimeType, size: a.size }),
        ),
      );
    }
    if (source === 'camera') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        toast.show({ title: 'Allow camera access in Settings to take photos', tone: 'error' });
        return;
      }
      try {
        const r = await ImagePicker.launchCameraAsync(PICKER);
        if (!r.canceled) await sendAll(r.assets.map((a) => () => fromPicker(a)));
      } catch {
        toast.show({ title: 'The camera isn’t available', tone: 'error' });
      }
      return;
    }
    // The system photo picker runs out of process: no library permission needed.
    const r = await ImagePicker.launchImageLibraryAsync({
      ...PICKER,
      allowsMultipleSelection: true,
      selectionLimit: 10,
    });
    if (!r.canceled) await sendAll(r.assets.map((a) => () => fromPicker(a)));
  };

  const sample = Object.values(devImages);

  return (
    <ScrollView
      className="flex-1 bg-surface-raised"
      contentContainerClassName="gap-5 px-4 pb-10 pt-6"
    >
      <View className="flex-row gap-3">
        {SOURCES.map((s) => (
          <PressableScale
            key={s.id}
            onPress={() => void pick(s.id)}
            disabled={busy}
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

      {busy && (
        <View
          className="flex-row items-center justify-center gap-2"
          accessibilityLiveRegion="polite"
        >
          <ActivityIndicator />
          <Text variant="footnote" tone="secondary">
            Preparing…
          </Text>
        </View>
      )}

      {__DEV__ && (
        <>
          <Text variant="footnote" tone="secondary" className="ml-1 font-medium uppercase">
            Sample photos (development)
          </Text>
          <View className="flex-row flex-wrap gap-1 overflow-hidden rounded-xl">
            {sample.map((img, i) => (
              <Pressable
                key={i}
                disabled={busy}
                onPress={() => {
                  haptics.tap();
                  if (!live) {
                    send(conversationId, { attachment: { kind: 'image', ...img } });
                    router.back();
                    return;
                  }
                  // Through the real pipeline: re-encode, upload, send.
                  void sendAll([
                    async () => {
                      const asset = await Asset.fromModule(img.source).downloadAsync();
                      return prepareImage({
                        uri: asset.localUri ?? asset.uri,
                        width: img.width,
                        height: img.height,
                      });
                    },
                  ]);
                }}
                accessibilityRole="imagebutton"
                accessibilityLabel={`Send sample photo ${i + 1}`}
                style={{ width: '32.6%', aspectRatio: 1 }}
              >
                <Image
                  source={img.source}
                  style={{ flex: 1 }}
                  contentFit="cover"
                  transition={150}
                />
              </Pressable>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}
