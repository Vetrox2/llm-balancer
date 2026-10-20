import {
  AllModelsFailedError,
  type AttemptFailure,
  LlmContentBlockedError,
  LlmProviderError,
} from './errors.ts';
import type { BalancerEvent } from './events.ts';
import type { FailureReport, HealthTracker } from './health/tracker.ts';
import type { ConverseRequest, ILlmProvider, ModelRef } from './types.ts';

/** A pool of models that answers like a single model. */
export interface IModelHandle {
  readonly pool: string;
  /**
   * Sends the request to the pool's models in fallback order until one answers.
   *
   * @throws {LlmContentBlockedError} when a vendor's safety filter blocks the content; no other
   *   model is tried and no model is put on a cooldown.
   * @throws {AllModelsFailedError} when no model answered; `failures` explains every model.
   */
  converse(request: ConverseRequest): Promise<string>;
}

/** What every handle of one balancer shares. */
export interface BalancerRuntime {
  providers: ReadonlyMap<string, ILlmProvider>;
  tracker: HealthTracker;
  requestBudgetMs: number;
  attemptTimeoutMs: number;
  emit(event: BalancerEvent): void;
}

type AttemptResult = { ok: true; text: string } | { ok: false; failure: FailureReport };

/**
 * Fallback over one pool. Healthy models go first in pool order, then unhealthy models whose
 * policy allows a last resort; the rest are skipped until their cooldown ends. Every attempt gets
 * `attemptTimeoutMs`, capped by what is left of `requestBudgetMs`.
 */
export class ModelHandle implements IModelHandle {
  constructor(
    readonly pool: string,
    private readonly candidates: readonly ModelRef[],
    private readonly runtime: BalancerRuntime,
  ) {}

  async converse(request: ConverseRequest): Promise<string> {
    const failures: AttemptFailure[] = [];
    const queue = await this.fallbackOrder(failures);
    const deadline = Date.now() + this.runtime.requestBudgetMs;

    for (const ref of queue) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        failures.push({
          ...ref,
          kind: 'timeout',
          message: 'Skipped: request time budget exhausted',
          skipped: true,
        });
        continue;
      }

      const result = await this.attempt(
        ref,
        request,
        Math.min(this.runtime.attemptTimeoutMs, remainingMs),
      );
      if (result.ok) {
        await this.runtime.tracker.markHealthy(ref);
        return result.text;
      }
      await this.recordFailure(ref, result.failure);
      failures.push({
        ...ref,
        kind: result.failure.kind,
        message: result.failure.message,
        skipped: false,
      });
    }

    this.runtime.emit({
      type: 'all_models_failed',
      level: 'error',
      data: { pool: this.pool, failures },
    });
    throw new AllModelsFailedError(this.pool, failures);
  }

  private async fallbackOrder(failures: AttemptFailure[]): Promise<ModelRef[]> {
    const healthy: ModelRef[] = [];
    const lastResort: ModelRef[] = [];

    for (const ref of this.candidates) {
      const cooldown = await this.runtime.tracker.unhealthyRecord(ref);
      if (cooldown === undefined) {
        healthy.push(ref);
      } else if (cooldown.lastResort) {
        lastResort.push(ref);
      } else {
        failures.push({
          ...ref,
          kind: cooldown.kind,
          message: `Skipped: cooling down after ${cooldown.kind} (${cooldown.reason})`,
          skipped: true,
        });
      }
    }
    return [...healthy, ...lastResort];
  }

  private async attempt(
    ref: ModelRef,
    request: ConverseRequest,
    timeoutMs: number,
  ): Promise<AttemptResult> {
    const provider = this.runtime.providers.get(ref.provider)!;
    const controller = new AbortController();
    const timedOut = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason));
    });
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    this.runtime.emit({ type: 'attempt', level: 'info', data: { pool: this.pool, ...ref } });
    try {
      // The race keeps the timeout even for a provider that ignores the abort signal.
      const text = await Promise.race([
        provider.converse(request, ref.model, controller.signal),
        timedOut,
      ]);
      return { ok: true, text };
    } catch (err) {
      if (err instanceof LlmContentBlockedError) {
        this.runtime.emit({
          type: 'content_blocked',
          level: 'warn',
          data: { pool: this.pool, ...ref, reason: err.reason },
        });
        throw err;
      }
      if (controller.signal.aborted) {
        return {
          ok: false,
          failure: { kind: 'timeout', message: `Attempt timed out after ${timeoutMs} ms` },
        };
      }
      return { ok: false, failure: this.classify(err) };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private classify(err: unknown): FailureReport {
    if (err instanceof LlmProviderError) {
      return { kind: err.kind, message: err.message, retryAfterSeconds: err.retryAfterSeconds };
    }
    return { kind: 'unknown', message: err instanceof Error ? err.message : String(err) };
  }

  private async recordFailure(ref: ModelRef, failure: FailureReport): Promise<void> {
    const { cooldownSeconds, lastResort } = await this.runtime.tracker.markFailed(ref, failure);
    this.runtime.emit({
      type: 'attempt_failed',
      level: 'warn',
      data: {
        pool: this.pool,
        ...ref,
        kind: failure.kind,
        cooldownSeconds,
        lastResort,
        error: failure.message,
      },
    });
  }
}
