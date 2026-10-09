import {
  ATTACHMENT_LIMITS,
  PREVIEW_MAX_CHARS,
  WAVEFORM_MAX_POINTS,
  type CreateAttachmentRequest,
} from '@koode/shared';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import type { LocalUpload } from '@/features/messaging/types';
import { fileSize, toOutbox } from './files';

/** What the outbox needs to send a file (the engine adds upload progress). */
export type UploadDraft = Omit<LocalUpload, 'attachmentId' | 'posterUploaded' | 'uploaded'>;

export class MediaError extends Error {}

const MAX_IMAGE_SIDE = 2048;
const POSTER_SIDE = 720;
const PREVIEW_SIDE = 24;

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

function checkSize(kind: keyof typeof ATTACHMENT_LIMITS, size: number) {
  if (size <= 0) throw new MediaError('That file is empty.');
  if (size > ATTACHMENT_LIMITS[kind])
    throw new MediaError(`That file is too large (the limit is ${mb(ATTACHMENT_LIMITS[kind])}).`);
}

/** Longest side ≤ max, keeping the aspect ratio. */
function fit(width: number, height: number, max: number) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Re-encode as JPEG (which also drops EXIF metadata such as GPS location). */
async function jpeg(uri: string, width: number, height: number, max: number, compress: number) {
  const size = fit(width, height, max);
  const ref = await ImageManipulator.manipulate(uri).resize(size).renderAsync();
  return ref.saveAsync({ format: SaveFormat.JPEG, compress });
}

/** A tiny placeholder image, sent inline with the message (shown while loading). */
async function preview(uri: string, width: number, height: number): Promise<string | null> {
  try {
    const ref = await ImageManipulator.manipulate(uri)
      .resize(fit(width, height, PREVIEW_SIDE))
      .renderAsync();
    const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.5, base64: true });
    return out.base64 && out.base64.length <= PREVIEW_MAX_CHARS ? out.base64 : null;
  } catch {
    return null;
  }
}

export async function prepareImage(asset: {
  uri: string;
  width: number;
  height: number;
}): Promise<UploadDraft> {
  if (!asset.width || !asset.height) throw new MediaError('That photo couldn’t be read.');
  const out = await jpeg(asset.uri, asset.width, asset.height, MAX_IMAGE_SIDE, 0.82);
  const uri = await toOutbox(out.uri, 'jpg');
  const sizeBytes = fileSize(uri);
  checkSize('image', sizeBytes);
  const request: CreateAttachmentRequest = {
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes,
    width: out.width,
    height: out.height,
    preview: await preview(out.uri, out.width, out.height),
  };
  return { uri, posterUri: null, request };
}

export async function prepareVideo(asset: {
  uri: string;
  width: number;
  height: number;
  durationMs: number | null;
  mimeType?: string | null;
  fileName?: string | null;
}): Promise<UploadDraft> {
  const mov = /\.mov$/i.test(asset.fileName ?? asset.uri) || asset.mimeType === 'video/quicktime';
  const uri = await toOutbox(asset.uri, mov ? 'mov' : 'mp4');
  const sizeBytes = fileSize(uri);
  checkSize('video', sizeBytes);
  let posterUri: string | null = null;
  let previewData: string | null = null;
  try {
    const thumb = await VideoThumbnails.getThumbnailAsync(uri, { time: 0, quality: 0.8 });
    const poster = await jpeg(thumb.uri, thumb.width, thumb.height, POSTER_SIDE, 0.7);
    posterUri = await toOutbox(poster.uri, 'jpg');
    previewData = await preview(poster.uri, poster.width, poster.height);
  } catch {
    // no poster: the bubble shows a plain video tile
  }
  const request: CreateAttachmentRequest = {
    kind: 'video',
    mimeType: mov ? 'video/quicktime' : 'video/mp4',
    sizeBytes,
    width: Math.max(1, Math.round(asset.width || 1)),
    height: Math.max(1, Math.round(asset.height || 1)),
    durationMs: Math.max(0, Math.round(asset.durationMs ?? 0)),
    preview: previewData,
  };
  return { uri, posterUri, request };
}

export async function prepareDocument(asset: {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
}): Promise<UploadDraft> {
  const ext = asset.name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin';
  const uri = await toOutbox(asset.uri, ext);
  const sizeBytes = fileSize(uri);
  checkSize('document', sizeBytes);
  // Paths and control characters never leave the device as part of a name.
  const name = asset.name.replace(/[/\\\u0000-\u001f\u007f]/g, '_').slice(0, 255) || 'File';
  const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(asset.mimeType ?? '')
    ? asset.mimeType!
    : 'application/octet-stream';
  return { uri, posterUri: null, request: { kind: 'document', mimeType, sizeBytes, name } };
}

/** Downsample metering levels to at most WAVEFORM_MAX_POINTS values in 0–1. */
export function waveformFrom(levels: number[]): number[] {
  if (levels.length === 0) return [];
  const n = Math.min(WAVEFORM_MAX_POINTS, levels.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * levels.length) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / n));
    const slice = levels.slice(start, end);
    out.push(Math.max(...slice));
  }
  return out.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100);
}

/** Metering is in dBFS (≈ −160…0); map the useful −50…0 range to 0–1. */
export const levelFromDb = (db: number) => Math.min(1, Math.max(0, (db + 50) / 50));

export async function prepareVoice(recording: {
  uri: string;
  durationMs: number;
  levels: number[];
}): Promise<UploadDraft> {
  const uri = await toOutbox(recording.uri, 'm4a');
  const sizeBytes = fileSize(uri);
  checkSize('voice', sizeBytes);
  return {
    uri,
    posterUri: null,
    request: {
      kind: 'voice',
      mimeType: 'audio/mp4',
      sizeBytes,
      durationMs: Math.round(recording.durationMs),
      waveform: waveformFrom(recording.levels),
    },
  };
}
