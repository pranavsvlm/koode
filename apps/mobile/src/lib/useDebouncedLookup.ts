import { useEffect, useState } from 'react';

export type Lookup<T> =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'done'; value: T }
  | { state: 'error'; error: unknown };

/**
 * Debounced async lookup for live form feedback (invite preview, username
 * availability). Results are keyed by input, so stale responses are ignored
 * and "checking" is derived rather than set inside the effect.
 */
export function useDebouncedLookup<T>(
  key: string | null,
  fetcher: (key: string) => Promise<T>,
  delayMs = 350,
): Lookup<T> {
  const [result, setResult] = useState<{ key: string; lookup: Lookup<T> } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetcher(key).then(
        (value) => !cancelled && setResult({ key, lookup: { state: 'done', value } }),
        (error: unknown) => !cancelled && setResult({ key, lookup: { state: 'error', error } }),
      );
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `fetcher` is expected to be stable (module-level function).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delayMs]);

  if (!key) return { state: 'idle' };
  return result?.key === key ? result.lookup : { state: 'checking' };
}
