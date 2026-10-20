import { BalancerConfigError } from './errors.ts';
import type { BalancerEvent, BalancerEventListener } from './events.ts';
import { type HealthRecord, type IHealthStore, MemoryHealthStore } from './health/store.ts';
import { HealthTracker } from './health/tracker.ts';
import { type IModelHandle, ModelHandle } from './model-handle.ts';
import { HealthPolicy, type HealthPolicyConfig } from './policy.ts';
import type { ILlmProvider, ModelRef, ModelRefOf } from './types.ts';

export interface TimeoutConfig {
  /** Time for the whole fallback chain of one request. Defaults to 60 000 ms. */
  requestBudgetMs?: number;
  /** Time for one model, capped by what is left of the budget. Defaults to 25 000 ms. */
  attemptTimeoutMs?: number;
}

/**
 * @typeParam Pool - The pool names (inferred from the keys of `pools`).
 * @typeParam P - The providers (inferred from `providers`); they type the model references.
 */
export interface LoadBalancerConfig<Pool extends string, P extends ILlmProvider> {
  /** Every provider the pools use, each with a unique `name`. */
  providers: readonly P[];
  /** Pool name -> models in fallback order. The same model may appear in several pools. */
  pools: Record<Pool, readonly NoInfer<ModelRefOf<P>>[]>;
  health?: HealthPolicyConfig;
  timeouts?: TimeoutConfig;
  /** Receives every attempt and failure. Errors thrown by the listener are ignored. */
  onEvent?: BalancerEventListener;
  /** Where model health is kept. Defaults to a {@link MemoryHealthStore} owned by this balancer. */
  healthStore?: IHealthStore;
}

/** The health of one model, as reported by {@link ILoadBalancer.status}. */
export interface ModelStatus<Pool extends string = string> extends ModelRef {
  pools: Pool[];
  healthy: boolean;
  /** Present while the model is cooling down. */
  cooldown?: HealthRecord;
}

/** Hands out pool handles. Depend on this interface to swap the balancer for a fake in tests. */
export interface ILoadBalancer<Pool extends string = string> {
  /** @throws {BalancerConfigError} when the pool was not configured. */
  model(pool: Pool): IModelHandle;
  /** One entry per distinct model of all pools, in the order they first appear. */
  status(): Promise<ModelStatus<Pool>[]>;
}

/**
 * Routes requests to pools of LLM models with automatic fallback and per-model health.
 *
 * The configuration is validated once, here, so mistakes fail at startup instead of on the first
 * request.
 *
 * @example
 * ```ts
 * const balancer = new LoadBalancer({
 *   providers: [gemini({ apiKey })],
 *   pools: { default: [{ provider: 'gemini', model: 'gemini-2.5-flash' }] },
 * });
 * const text = await balancer.model('default').converse({ messages: [{ role: 'user', content: 'Hi' }] });
 * ```
 *
 * @throws {BalancerConfigError} when there are no pools, a pool is empty or lists a model twice,
 *   a model points at an unknown provider, two providers share a name, or a timeout or cooldown
 *   is not a valid number.
 */
export class LoadBalancer<Pool extends string, P extends ILlmProvider = ILlmProvider>
  implements ILoadBalancer<Pool> {
  static readonly DEFAULT_REQUEST_BUDGET_MS = 60_000;
  static readonly DEFAULT_ATTEMPT_TIMEOUT_MS = 25_000;

  private readonly handles = new Map<string, ModelHandle>();
  private readonly tracker: HealthTracker;

  constructor(private readonly config: LoadBalancerConfig<Pool, P>) {
    const providers = this.indexProviders(config.providers);
    this.validatePools(providers);

    this.tracker = new HealthTracker(
      config.healthStore ?? new MemoryHealthStore(),
      new HealthPolicy(config.health),
    );
    const runtime = {
      providers,
      tracker: this.tracker,
      requestBudgetMs: this.positiveMs(
        'timeouts.requestBudgetMs',
        config.timeouts?.requestBudgetMs ?? LoadBalancer.DEFAULT_REQUEST_BUDGET_MS,
      ),
      attemptTimeoutMs: this.positiveMs(
        'timeouts.attemptTimeoutMs',
        config.timeouts?.attemptTimeoutMs ?? LoadBalancer.DEFAULT_ATTEMPT_TIMEOUT_MS,
      ),
      emit: (event: BalancerEvent) => this.emit(event),
    };
    for (const [pool, refs] of this.poolEntries()) {
      this.handles.set(pool, new ModelHandle(pool, refs, runtime));
    }
  }

  model(pool: Pool): IModelHandle {
    const handle = this.handles.get(pool);
    if (!handle) throw new BalancerConfigError(`Unknown pool '${pool}'`);
    return handle;
  }

  async status(): Promise<ModelStatus<Pool>[]> {
    const byKey = new Map<string, ModelStatus<Pool>>();
    for (const [pool, refs] of this.poolEntries()) {
      for (const { provider, model } of refs) {
        const key = `${provider}:${model}`;
        const known = byKey.get(key);
        if (known) known.pools.push(pool);
        else byKey.set(key, { provider, model, pools: [pool], healthy: true });
      }
    }

    for (const status of byKey.values()) {
      const cooldown = await this.tracker.unhealthyRecord(status);
      if (cooldown) Object.assign(status, { healthy: false, cooldown });
    }
    return [...byKey.values()];
  }

  private poolEntries(): Array<[Pool, readonly ModelRef[]]> {
    return Object.entries(this.config.pools) as Array<[Pool, readonly ModelRef[]]>;
  }

  private indexProviders(providers: readonly ILlmProvider[]): Map<string, ILlmProvider> {
    const byName = new Map<string, ILlmProvider>();
    for (const provider of providers) {
      if (byName.has(provider.name)) {
        throw new BalancerConfigError(`Duplicate provider name '${provider.name}'`);
      }
      byName.set(provider.name, provider);
    }
    return byName;
  }

  private validatePools(providers: ReadonlyMap<string, ILlmProvider>): void {
    const entries = this.poolEntries();
    if (entries.length === 0) throw new BalancerConfigError('At least one pool is required');

    for (const [pool, refs] of entries) {
      if (refs.length === 0) throw new BalancerConfigError(`Pool '${pool}' has no models`);

      const seen = new Set<string>();
      for (const { provider, model } of refs) {
        if (!providers.has(provider)) {
          throw new BalancerConfigError(`Pool '${pool}' uses unknown provider '${provider}'`);
        }
        if (!model.trim()) {
          throw new BalancerConfigError(`Pool '${pool}' has an empty model name`);
        }
        const key = `${provider}:${model}`;
        if (seen.has(key)) throw new BalancerConfigError(`Pool '${pool}' lists '${key}' twice`);
        seen.add(key);
      }
    }
  }

  private positiveMs(path: string, value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      throw new BalancerConfigError(`${path} must be a positive number, got ${value}`);
    }
    return value;
  }

  private emit(event: BalancerEvent): void {
    try {
      this.config.onEvent?.(event);
    } catch {
      // A broken listener must not break the request it reports on.
    }
  }
}
