import { ApiClientError } from '@/lib/api';

/** Human wording for auth failures. Never shows raw server or network detail. */
export function authErrorMessage(e: unknown): string {
  if (!(e instanceof ApiClientError)) return 'Something went wrong. Please try again.';
  switch (e.code) {
    case 'network':
    case 'timeout':
      return 'Can’t reach Koode. Check your connection and try again.';
    case 'rate_limited':
      return 'Too many attempts. Please wait a bit and try again.';
    case 'forbidden':
    case 'conflict':
    case 'unauthorized':
    case 'bad_request':
      return e.message;
    default:
      return 'Something went wrong. Please try again.';
  }
}
