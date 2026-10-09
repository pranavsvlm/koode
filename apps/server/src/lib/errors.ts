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
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function errorBody(
  code: ApiErrorCode,
  message: string,
  requestId?: string,
  details?: unknown,
): ApiErrorBody {
  return { error: { code, message, requestId, ...(details !== undefined && { details }) } };
}
