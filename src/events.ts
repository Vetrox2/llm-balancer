import type { AttemptFailure, FailureKind } from './errors.ts';

/**
 * What the balancer reports through `onEvent`. `level` is a suggested log level, so the events
 * can be forwarded to a logger directly: `onEvent: (e) => logger[e.level](e.type, e.data)`.
 * Events never contain request or answer content.
 */
export type BalancerEvent =
  | {
    type: 'attempt';
    level: 'info';
    data: { pool: string; provider: string; model: string };
  }
  | {
    type: 'attempt_failed';
    level: 'warn';
    data: {
      pool: string;
      provider: string;
      model: string;
      kind: FailureKind;
      cooldownSeconds: number;
      lastResort: boolean;
      error: string;
    };
  }
  | {
    type: 'content_blocked';
    level: 'warn';
    data: { pool: string; provider: string; model: string; reason: string };
  }
  | {
    type: 'all_models_failed';
    level: 'error';
    data: { pool: string; failures: readonly AttemptFailure[] };
  };

export type BalancerEventListener = (event: BalancerEvent) => void;
