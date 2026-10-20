import { assertThrows } from '@std/assert';
import { BalancerConfigError, type ILlmProvider, LoadBalancer, type ModelRef } from '../mod.ts';
import { ScriptedProvider } from './testing/scripted-provider.ts';

const provider = new ScriptedProvider('test', () => 'ok');
const valid = { default: [{ provider: 'test', model: 'm' }] };

function build(config: {
  providers?: ILlmProvider[];
  pools?: Record<string, ModelRef[]>;
  defaultCooldownSeconds?: number;
  requestBudgetMs?: number;
  attemptTimeoutMs?: number;
}) {
  return new LoadBalancer({
    providers: config.providers ?? [provider],
    pools: config.pools ?? valid,
    health: { defaultCooldownSeconds: config.defaultCooldownSeconds },
    timeouts: {
      requestBudgetMs: config.requestBudgetMs,
      attemptTimeoutMs: config.attemptTimeoutMs,
    },
  });
}

const invalidConfigs: Array<[string, Parameters<typeof build>[0], string]> = [
  ['no pools', { pools: {} }, 'At least one pool'],
  ['an empty pool', { pools: { default: [] } }, "Pool 'default' has no models"],
  [
    'an unknown provider',
    { pools: { default: [{ provider: 'nope', model: 'm' }] } },
    "unknown provider 'nope'",
  ],
  ['a duplicate provider name', { providers: [provider, provider] }, 'Duplicate provider name'],
  [
    'a model listed twice in one pool',
    { pools: { default: [{ provider: 'test', model: 'm' }, { provider: 'test', model: 'm' }] } },
    "lists 'test:m' twice",
  ],
  [
    'an empty model name',
    { pools: { default: [{ provider: 'test', model: ' ' }] } },
    'empty model',
  ],
  ['a negative cooldown', { defaultCooldownSeconds: -1 }, 'defaultCooldownSeconds'],
  ['a zero request budget', { requestBudgetMs: 0 }, 'requestBudgetMs'],
  ['an infinite attempt timeout', { attemptTimeoutMs: Infinity }, 'attemptTimeoutMs'],
];

for (const [name, config, message] of invalidConfigs) {
  Deno.test(`rejects ${name} at construction`, () => {
    assertThrows(() => build(config), BalancerConfigError, message);
  });
}

Deno.test('rejects a negative per-kind cooldown', () => {
  assertThrows(
    () =>
      new LoadBalancer({
        providers: [provider],
        pools: { default: [{ provider: 'test', model: 'm' }] },
        health: { byKind: { timeout: { cooldownSeconds: -5 } } },
      }),
    BalancerConfigError,
    'health.byKind.timeout.cooldownSeconds',
  );
});

Deno.test('an unknown pool name is rejected at runtime too', () => {
  const balancer = build({}) as LoadBalancer<string>;
  assertThrows(() => balancer.model('other'), BalancerConfigError, "Unknown pool 'other'");
});
