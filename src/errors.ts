/**
 * Why an attempt failed. The balancer looks up the cooldown and last-resort policy by this kind.
 *
 * - `rate_limited` - the usage limit is used up (HTTP 429)
 * - `overloaded` - the vendor is temporarily out of capacity (HTTP 503)
 * - `timeout` - the attempt timeout or the request budget ran out
 * - `server_error` - any other 5xx answer
 * - `invalid_response` - the answer arrived but is empty or unreadable
 * - `auth` - the credentials were rejected (HTTP 401/403)
 * - `not_found` - the model does not exist or is not available (HTTP 404)
 * - `unknown` - anything the provider could not classify
 */
export type FailureKind =
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'server_error'
  | 'invalid_response'
  | 'auth'
  | 'not_found'
  | 'unknown';

export interface LlmProviderErrorOptions {
  kind: FailureKind;
  message: string;
  /** How long the vendor asked to wait. The model's cooldown is never shorter than this. */
  retryAfterSeconds?: number;
  /** HTTP status of the vendor's answer, when there was one. */
  status?: number;
  cause?: unknown;
}

/**
 * A classified failure of one attempt. Throw it from {@link ILlmProvider.converse} so the balancer
 * can cool the model down for the right amount of time and move on to the next model.
 */
export class LlmProviderError extends Error {
  readonly kind: FailureKind;
  readonly retryAfterSeconds?: number;
  readonly status?: number;

  constructor({ kind, message, retryAfterSeconds, status, cause }: LlmProviderErrorOptions) {
    super(message, { cause });
    this.name = 'LlmProviderError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
  }
}

/**
 * The vendor's safety filter blocked the request or the answer. Another model would most likely
 * block it too, so this ends the fallback chain without putting the model on a cooldown.
 */
export class LlmContentBlockedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`The provider blocked the content (${reason}).`);
    this.name = 'LlmContentBlockedError';
    this.reason = reason;
  }
}

/** One model that did not produce an answer during a request. */
export interface AttemptFailure {
  provider: string;
  model: string;
  kind: FailureKind;
  message: string;
  /** True when the model was not called at all (cooling down or out of time budget). */
  skipped: boolean;
}

/** No model of the pool produced an answer. `failures` lists every model in the order handled. */
export class AllModelsFailedError extends Error {
  readonly pool: string;
  readonly failures: readonly AttemptFailure[];

  constructor(pool: string, failures: readonly AttemptFailure[]) {
    const summary = failures.map((f) => `[${f.provider}:${f.model}] ${f.message}`).join('; ');
    super(`All models failed for pool '${pool}': ${summary}`);
    this.name = 'AllModelsFailedError';
    this.pool = pool;
    this.failures = failures;
  }
}

/** The balancer or a provider factory received an invalid configuration, or an unknown pool. */
export class BalancerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BalancerConfigError';
  }
}
