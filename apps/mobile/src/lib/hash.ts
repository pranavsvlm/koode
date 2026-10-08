/** Small, stable string hash (djb2). Not for security — only for picking colours. */
export function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}
