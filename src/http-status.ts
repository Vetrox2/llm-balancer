import type { FailureKind } from './errors.ts';

/**
 * The usual meaning of an HTTP error status, for providers that talk to an HTTP API.
 *
 * @example
 * ```ts
 * if (!response.ok) {
 *   throw new LlmProviderError({
 *     kind: failureKindForStatus(response.status),
 *     status: response.status,
 *     message: `HTTP ${response.status}`,
 *   });
 * }
 * ```
 */
export function failureKindForStatus(status: number): FailureKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 503) return 'overloaded';
  if (status >= 500) return 'server_error';
  return 'unknown';
}
