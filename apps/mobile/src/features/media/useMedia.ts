import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Attachment } from '@/domain/types';
import { cachedPosterUri, cachedUri, download } from './files';

type Part = 'content' | 'thumbnail';

/** Server metadata needed to fetch an attachment, or null for sample/pending ones. */
export function remoteOf(a: Attachment | undefined) {
  if (!a?.attachmentId) return null;
  return {
    id: a.attachmentId,
    mimeType: a.mimeType ?? 'application/octet-stream',
    name: a.kind === 'document' ? a.name : null,
    secret: a.secret,
  };
}

function localFor(a: Attachment | undefined, part: Part): string | null {
  if (!a) return null;
  if (part === 'thumbnail') {
    if (a.localPosterUri) return a.localPosterUri;
    return a.attachmentId ? cachedPosterUri(a.attachmentId) : null;
  }
  if (a.localUri) return a.localUri;
  const remote = remoteOf(a);
  return remote ? cachedUri(remote) : null;
}

/**
 * A local file for an attachment: already on the device (being sent, or
 * cached), or downloaded with the user's credentials. `auto` downloads as soon
 * as it's shown (images, posters, voice); otherwise call `load()` (videos and
 * documents, on tap).
 */
export function useMediaFile(a: Attachment | undefined, part: Part = 'content', auto = true) {
  const key = `${a?.attachmentId ?? a?.localUri ?? ''}:${part}`;
  // On the device already (being sent, or cached)? Checked once per attachment.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const local = useMemo(() => localFor(a, part), [key]);
  const remote = remoteOf(a);
  const fetchable = !!remote && (part === 'content' || !!a?.hasPoster);
  const [result, setResult] = useState<{ key: string; uri: string | null } | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  const settled = result?.key === key ? result : null;
  const uri = local ?? settled?.uri ?? null;

  // Only sets state once the download settles (never synchronously in an effect).
  const fetchFile = useCallback(async (): Promise<string | null> => {
    if (!remote || !fetchable) return null;
    try {
      const file = await download(remote, part);
      setResult({ key, uri: file });
      return file;
    } catch {
      setResult({ key, uri: null });
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fetchable]);

  useEffect(() => {
    if (!auto || local || !remote || !fetchable) return;
    let current = true;
    download(remote, part).then(
      (file) => current && setResult({ key, uri: file }),
      () => current && setResult({ key, uri: null }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, auto, local, fetchable]);

  const load = useCallback(async () => {
    if (uri) return uri;
    setRequested(key);
    return fetchFile();
  }, [uri, key, fetchFile]);

  return {
    uri,
    loading: !uri && !settled && fetchable && (auto || requested === key),
    failed: !!settled && !settled.uri,
    load,
  };
}

/** Inline placeholder for expo-image. */
export const previewSource = (a: Attachment | undefined) =>
  a?.preview ? { uri: `data:image/jpeg;base64,${a.preview}` } : undefined;
