import { assertEquals } from '@std/assert';
import { MemoryHealthStore } from '../mod.ts';
import { HealthTracker } from '../src/health/tracker.ts';
import { HealthPolicy } from '../src/policy.ts';
import { withClock } from './testing/clock.ts';

const M1 = { provider: 'gemini', model: 'm1' };

function tracker(policy = new HealthPolicy({ defaultCooldownSeconds: 60 })) {
  return new HealthTracker(new MemoryHealthStore(), policy);
}

Deno.test('a failed model is unhealthy until the cooldown passes', async () => {
  await withClock(async (advance) => {
    const health = tracker();
    await health.markFailed(M1, { kind: 'server_error', message: 'boom' });

    assertEquals((await health.unhealthyRecord(M1))?.reason, 'boom');
    advance(59_000);
    assertEquals((await health.unhealthyRecord(M1))?.kind, 'server_error');
    advance(2_000);
    assertEquals(await health.unhealthyRecord(M1), undefined);
  });
});

Deno.test('markHealthy clears the cooldown immediately', async () => {
  const health = tracker();
  await health.markFailed(M1, { kind: 'unknown', message: 'boom' });
  await health.markHealthy(M1);
  assertEquals(await health.unhealthyRecord(M1), undefined);
});

Deno.test('an infinite cooldown never expires on its own', async () => {
  await withClock(async (advance) => {
    const health = tracker(new HealthPolicy({ byKind: { auth: { cooldownSeconds: Infinity } } }));
    await health.markFailed(M1, { kind: 'auth', message: 'bad key' });
    advance(365 * 24 * 3600 * 1000);
    assertEquals((await health.unhealthyRecord(M1))?.kind, 'auth');
  });
});

Deno.test('rate limits, bad credentials and missing models are not a last resort by default', () => {
  const policy = new HealthPolicy();
  const lastResortByKind = Object.fromEntries(
    (['rate_limited', 'auth', 'not_found', 'overloaded', 'timeout', 'unknown'] as const).map(
      (kind) => [kind, policy.resolve(kind).lastResort],
    ),
  );
  assertEquals(lastResortByKind, {
    rate_limited: false,
    auth: false,
    not_found: false,
    overloaded: true,
    timeout: true,
    unknown: true,
  });
});

Deno.test('a per-kind override keeps the defaults for the fields it leaves out', () => {
  const policy = new HealthPolicy({
    defaultCooldownSeconds: 90,
    byKind: { rate_limited: { cooldownSeconds: 30 }, timeout: { lastResort: false } },
  });
  assertEquals(policy.resolve('rate_limited'), { cooldownSeconds: 30, lastResort: false });
  assertEquals(policy.resolve('timeout'), { cooldownSeconds: 90, lastResort: false });
  assertEquals(policy.resolve('overloaded'), { cooldownSeconds: 90, lastResort: true });
});

Deno.test('the retry delay from the provider wins only when it is longer', () => {
  const policy = new HealthPolicy({ defaultCooldownSeconds: 60 });
  assertEquals(policy.resolve('rate_limited', 3600).cooldownSeconds, 3600);
  assertEquals(policy.resolve('rate_limited', 5).cooldownSeconds, 60);
});
