export class HttpResponseError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(response: Response) {
    super(`HTTP ${response.status} ${response.statusText}`);
    this.name = "HttpResponseError";
    this.status = response.status;
    this.retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
  }
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

export function isRetryableRequestError(error: unknown): boolean {
  return !isHttpResponseError(error) || error.status === 408 || error.status === 429 || error.status >= 500;
}

export function retryDelayMilliseconds(error: unknown, failedAttempt: number, maximumBackoffMs = 8_000): number {
  if (isHttpResponseError(error) && error.retryAfterMs !== undefined) return error.retryAfterMs;
  const initialDelayMs = isHttpResponseError(error) && error.status === 429 ? 5_000 : 500;
  return Math.min(initialDelayMs * 2 ** Math.max(0, failedAttempt - 1), maximumBackoffMs);
}
