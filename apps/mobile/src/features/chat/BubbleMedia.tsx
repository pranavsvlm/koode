import { Image } from 'expo-image';
import { View, type ImageStyle, type StyleProp } from 'react-native';
import { Text } from '@/components/ui';
import type { Attachment } from '@/domain/types';
import { previewSource, useMediaFile } from '@/features/media/useMedia';

type Visual = Extract<Attachment, { kind: 'image' | 'video' }>;

/**
 * A photo, or a video's poster. Sample data uses bundled images; live
 * attachments show their inline preview until the file (downloaded with the
 * user's credentials, then cached) is ready.
 */
export function BubbleMedia({
  attachment,
  style,
}: {
  attachment: Visual;
  style: StyleProp<ImageStyle>;
}) {
  const bundled = attachment.kind === 'image' ? attachment.source : attachment.poster;
  const part = attachment.kind === 'image' ? 'content' : 'thumbnail';
  const file = useMediaFile(bundled ? undefined : attachment, part);
  const source = bundled ?? (file.uri ? { uri: file.uri } : undefined);

  return (
    <View>
      <Image
        source={source}
        placeholder={previewSource(attachment)}
        placeholderContentFit="cover"
        style={[style, { backgroundColor: 'rgba(127,127,127,0.25)' }]}
        contentFit="cover"
        transition={200}
        recyclingKey={attachment.attachmentId ?? attachment.localUri}
        // Decrypted files are already local: no second (plaintext) copy on disk.
        cachePolicy="memory"
        accessibilityIgnoresInvertColors
      />
      {attachment.progress !== undefined && (
        <View className="absolute inset-0 items-center justify-center bg-black/30">
          <View className="rounded-full bg-black/55 px-3 py-1">
            <Text variant="caption" style={{ color: '#FFFFFF' }}>
              {`Sending ${Math.round(attachment.progress * 100)}%`}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

/** "PDF", "DOCX"… from the file name, for document bubbles. */
export function fileTypeLabel(name: string, mimeType: string): string {
  const ext = name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  if (ext) return ext.toUpperCase();
  return mimeType.split('/')[1]?.toUpperCase().slice(0, 8) ?? 'FILE';
}
