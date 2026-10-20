import type { FailureKind } from '../errors.ts';

/** Why and until when one model is unhealthy. */
export interface HealthRecord {
  kind: FailureKind;
  reason: string;
  /** Epoch milliseconds; `Infinity` means until the record is removed. */
  until: number;
  lastResort: boolean;
}

/**
 * Where model health is kept, keyed by `provider:model`. Implement it to share health between
 * processes (for example in Redis); the balancer decides about expiry, a store only keeps records.
 * A store that serializes records must preserve `until: Infinity`.
 */
export interface IHealthStore {
  get(key: string): Promise<HealthRecord | undefined>;
  set(key: string, record: HealthRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The default store: health lives in this process (one serverless isolate, one server). */
export class MemoryHealthStore implements IHealthStore {
  private readonly records = new Map<string, HealthRecord>();

  get(key: string): Promise<HealthRecord | undefined> {
    return Promise.resolve(this.records.get(key));
  }

  set(key: string, record: HealthRecord): Promise<void> {
    this.records.set(key, record);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }
}
