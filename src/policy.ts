import { BalancerConfigError, type FailureKind } from './errors.ts';

/** How the balancer treats a model after one kind of failure. */
export interface FailurePolicy {
  /** How long the model counts as unhealthy. `Infinity` keeps it out until the process restarts. */
  cooldownSeconds?: number;
  /**
   * Whether an unhealthy model may still be tried when every healthy model has failed.
   * Use `false` when retrying cannot help before the cooldown ends (a used-up quota, bad keys).
   */
  lastResort?: boolean;
}

export interface HealthPolicyConfig {
  /** Cooldown for every kind without its own `cooldownSeconds`. Defaults to 60. */
  defaultCooldownSeconds?: number;
  /** Per-kind overrides; fields left out fall back to the defaults. */
  byKind?: Partial<Record<FailureKind, FailurePolicy>>;
}

export interface ResolvedFailurePolicy {
  cooldownSeconds: number;
  lastResort: boolean;
}

/**
 * Turns a failure into a cooldown. A `retryAfterSeconds` from the vendor always wins over a
 * shorter configured cooldown: the model would only fail again before that time.
 *
 * Out of the box `rate_limited`, `auth` and `not_found` are not tried as a last resort; every
 * other kind is.
 *
 * @throws {BalancerConfigError} when a cooldown is negative or not a number.
 */
export class HealthPolicy {
  static readonly DEFAULT_COOLDOWN_SECONDS = 60;
  private static readonly NOT_A_LAST_RESORT: ReadonlySet<FailureKind> = new Set([
    'rate_limited',
    'auth',
    'not_found',
  ]);

  private readonly defaultCooldownSeconds: number;
  private readonly byKind: Partial<Record<FailureKind, FailurePolicy>>;

  constructor({ defaultCooldownSeconds, byKind = {} }: HealthPolicyConfig = {}) {
    this.defaultCooldownSeconds = defaultCooldownSeconds ?? HealthPolicy.DEFAULT_COOLDOWN_SECONDS;
    this.byKind = byKind;

    this.assertValidCooldown('health.defaultCooldownSeconds', this.defaultCooldownSeconds);
    for (const [kind, policy] of Object.entries(byKind)) {
      if (policy?.cooldownSeconds !== undefined) {
        this.assertValidCooldown(`health.byKind.${kind}.cooldownSeconds`, policy.cooldownSeconds);
      }
    }
  }

  resolve(kind: FailureKind, retryAfterSeconds?: number): ResolvedFailurePolicy {
    const override = this.byKind[kind];
    const configuredCooldown = override?.cooldownSeconds ?? this.defaultCooldownSeconds;
    return {
      cooldownSeconds: Math.max(configuredCooldown, retryAfterSeconds ?? 0),
      lastResort: override?.lastResort ?? !HealthPolicy.NOT_A_LAST_RESORT.has(kind),
    };
  }

  private assertValidCooldown(path: string, seconds: number): void {
    if (Number.isNaN(seconds) || seconds < 0) {
      throw new BalancerConfigError(`${path} must be a non-negative number, got ${seconds}`);
    }
  }
}
