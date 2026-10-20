import type { FailureKind } from '../errors.ts';
import type { HealthPolicy, ResolvedFailurePolicy } from '../policy.ts';
import type { ModelRef } from '../types.ts';
import type { HealthRecord, IHealthStore } from './store.ts';

export interface FailureReport {
  kind: FailureKind;
  message: string;
  retryAfterSeconds?: number;
}

/** Applies the health policy on top of a store: records failures and forgets expired cooldowns. */
export class HealthTracker {
  constructor(
    private readonly store: IHealthStore,
    private readonly policy: HealthPolicy,
  ) {}

  /** @returns the active cooldown record, or `undefined` when the model is healthy. */
  async unhealthyRecord(ref: ModelRef): Promise<HealthRecord | undefined> {
    const key = this.keyOf(ref);
    const record = await this.store.get(key);
    if (record === undefined) return undefined;

    if (Date.now() >= record.until) {
      await this.store.delete(key);
      return undefined;
    }
    return record;
  }

  async markFailed(ref: ModelRef, failure: FailureReport): Promise<ResolvedFailurePolicy> {
    const policy = this.policy.resolve(failure.kind, failure.retryAfterSeconds);
    await this.store.set(this.keyOf(ref), {
      kind: failure.kind,
      reason: failure.message,
      until: Date.now() + policy.cooldownSeconds * 1000,
      lastResort: policy.lastResort,
    });
    return policy;
  }

  async markHealthy(ref: ModelRef): Promise<void> {
    await this.store.delete(this.keyOf(ref));
  }

  private keyOf({ provider, model }: ModelRef): string {
    return `${provider}:${model}`;
  }
}
