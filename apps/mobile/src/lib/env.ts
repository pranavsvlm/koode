import { z } from 'zod';

const EnvSchema = z.object({
  apiUrl: z.url(),
});
export type AppEnv = z.infer<typeof EnvSchema>;

const DEV_DEFAULT_API_URL = 'http://localhost:8787';

/**
 * Validate public build-time configuration. Release builds must talk to the
 * API over HTTPS; plain HTTP is accepted only in development builds.
 */
export function parseEnv(raw: { apiUrl: string | undefined }, isDev: boolean): AppEnv {
  const env = EnvSchema.parse({ apiUrl: raw.apiUrl ?? (isDev ? DEV_DEFAULT_API_URL : undefined) });
  if (!isDev && !env.apiUrl.startsWith('https://')) {
    throw new Error('EXPO_PUBLIC_API_URL must use https:// in release builds');
  }
  return { apiUrl: env.apiUrl.replace(/\/+$/, '') };
}

// EXPO_PUBLIC_* must be referenced literally so Metro can inline it.
export const env = parseEnv({ apiUrl: process.env.EXPO_PUBLIC_API_URL }, __DEV__);
