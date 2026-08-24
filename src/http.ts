export class HttpResponseError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  /** Unclamped value used for user-facing retry reporting. */
  readonly retryAfterTotalMs?: number;
  readonly retryAfterAt?: string;

  constructor(response: Response) {
    super(`HTTP ${response.status} ${response.statusText}`);
    this.name = "HttpResponseError";
    this.status = response.status;
    const retryAfter = response.headers.get("retry-after");
    this.retryAfterMs = retryAfterMilliseconds(retryAfter);
    this.retryAfterTotalMs = retryAfterMillisecondsUnbounded(retryAfter);
    if (this.retryAfterTotalMs !== undefined) {
      this.retryAfterAt = new Date(Date.now() + this.retryAfterTotalMs).toISOString();
    }
  }
}

export function retryAfterMillisecondsUnbounded(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(seconds * 1_000)) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(seconds * 1_000, 60_000) : undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), 60_000) : undefined;
}

export function httpErrorFromResponse(response: Response): HttpResponseError {
  return new HttpResponseError(response);
}

export function isHttpResponseError(error: unknown): error is HttpResponseError {
  return error instanceof HttpResponseError;
}

export function findHttpResponseError(error: unknown): HttpResponseError | undefined {
  const visited = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    if (isHttpResponseError(current)) return current;
    visited.add(current);
    current = current.cause;
  }
  return undefined;
}

export function isRetryableRequestError(error: unknown): boolean {
  return !isHttpResponseError(error) || error.status === 408 || error.status === 429 || error.status >= 500;
}

export function retryDelayMilliseconds(error: unknown, failedAttempt: number, maximumBackoffMs = 8_000): number {
  if (isHttpResponseError(error) && error.retryAfterMs !== undefined) return error.retryAfterMs;
  const status = isHttpResponseError(error) ? error.status : undefined;
  const initialDelayMs = status === 429 || status === 502 || status === 503 || status === 504 ? 5_000 : 500;
  return Math.min(initialDelayMs * 2 ** Math.max(0, failedAttempt - 1), maximumBackoffMs);
}
