import type { ApiErrorBody, ApiErrorCode } from '@koode/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const STATUS_BY_CODE: Record<ApiErrorCode, ContentfulStatusCode> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  not_implemented: 501,
  internal: 500,
};

/** Throw from any handler to return a typed JSON error to the client. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: ContentfulStatusCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function errorBody(code: ApiErrorCode, message: string, requestId?: string): ApiErrorBody {
  return { error: { code, message, requestId } };
}
