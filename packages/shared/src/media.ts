import { z } from 'zod';

export const AttachmentKind = z.enum(['image', 'video', 'document', 'voice']);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

const MB = 1024 * 1024;
/** Upload limits per kind (bytes). Worker request bodies are capped at 100 MB. */
export const ATTACHMENT_LIMITS: Record<AttachmentKind, number> = {
  image: 20 * MB,
  video: 100 * MB,
  document: 100 * MB,
  voice: 15 * MB,
};
/** Video posters (JPEG). */
export const THUMBNAIL_LIMIT = 512 * 1024;
/** Inline placeholder (tiny base64 JPEG) carried in the message itself. */
export const PREVIEW_MAX_CHARS = 6000;
export const WAVEFORM_MAX_POINTS = 64;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'image/gif'];
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
export const VOICE_TYPES = ['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg'];

const Size = (max: number) => z.number().int().positive().max(max, 'File is too large');
const Dimension = z.number().int().min(1).max(20_000);
const Preview = z
  .string()
  .max(PREVIEW_MAX_CHARS)
  .regex(/^[A-Za-z0-9+/]+=*$/, 'Preview must be base64');
/** A file name without paths or control characters. */
const FileName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  // Control characters are exactly what this rejects.
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[/\\\u0000-\u001f\u007f]/.test(s), 'Invalid file name');

/** Ask to upload a file into a conversation (the content is PUT separately). */
export const CreateAttachmentRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    mimeType: z.enum(IMAGE_TYPES),
    sizeBytes: Size(ATTACHMENT_LIMITS.image),
    width: Dimension,
    height: Dimension,
    preview: Preview.nullable().optional(),
  }),
  z.object({
    kind: z.literal('video'),
    mimeType: z.enum(VIDEO_TYPES),
    sizeBytes: Size(ATTACHMENT_LIMITS.video),
    width: Dimension,
    height: Dimension,
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(3 * 3600_000),
    preview: Preview.nullable().optional(),
  }),
  z.object({
    kind: z.literal('voice'),
    mimeType: z.enum(VOICE_TYPES),
    sizeBytes: Size(ATTACHMENT_LIMITS.voice),
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 60_000),
    waveform: z.array(z.number().min(0).max(1)).max(WAVEFORM_MAX_POINTS),
  }),
  z.object({
    kind: z.literal('document'),
    mimeType: z
      .string()
      .max(127)
      .regex(/^[\w.+-]+\/[\w.+-]+$/, 'Invalid file type'),
    sizeBytes: Size(ATTACHMENT_LIMITS.document),
    name: FileName,
  }),
]);
export type CreateAttachmentRequest = z.input<typeof CreateAttachmentRequest>;

/**
 * Attachment metadata as carried in messages. Never a URL: content is fetched
 * from `/v1/attachments/:id/content` with the caller's credentials.
 */
export const AttachmentMeta = z.object({
  id: z.string(),
  kind: AttachmentKind,
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  name: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  waveform: z.array(z.number()).nullable(),
  preview: z.string().nullable(),
  hasThumbnail: z.boolean(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMeta>;

/** Short description of an attachment for previews and notifications. */
export function attachmentLabel(a: Pick<AttachmentMeta, 'kind' | 'name'>): string {
  switch (a.kind) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'voice':
      return '🎤 Voice message';
    case 'document':
      return `📄 ${a.name ?? 'Document'}`;
  }
}
