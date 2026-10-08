import { HealthResponse } from '@koode/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from './api';

export type ServerHealth =
  | { state: 'checking' }
  | { state: 'online'; environment: string }
  | { state: 'offline'; reason: string };

async function fetchServerHealth(signal?: AbortSignal): Promise<ServerHealth> {
  try {
    const res = await apiRequest('/health', HealthResponse, { signal, timeoutMs: 5_000 });
    return { state: 'online', environment: res.environment };
  } catch (err) {
    return { state: 'offline', reason: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export function useServerHealth() {
  const [health, setHealth] = useState<ServerHealth>({ state: 'checking' });

  useEffect(() => {
    const controller = new AbortController();
    void fetchServerHealth(controller.signal).then((result) => {
      if (!controller.signal.aborted) setHealth(result);
    });
    return () => controller.abort();
  }, []);

  const recheck = useCallback(() => {
    setHealth({ state: 'checking' });
    void fetchServerHealth().then(setHealth);
  }, []);

  return { health, recheck };
}
