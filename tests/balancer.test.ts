import { assert, assertEquals, assertRejects, assertStrictEquals } from '@std/assert';
import {
  AllModelsFailedError,
  type BalancerEvent,
  type ConverseRequest,
  type HealthPolicyConfig,
  type HealthRecord,
  LlmContentBlockedError,
  LlmProviderError,
  LoadBalancer,
  MemoryHealthStore,
} from '../mod.ts';
import { withClock } from './testing/clock.ts';
import { hang, type Script, ScriptedProvider } from './testing/scripted-provider.ts';

const REQUEST: ConverseRequest = { system: 's', messages: [{ role: 'user', content: 'p' }] };

function createBalancer(
  script: Script,
  options: { health?: HealthPolicyConfig; requestBudgetMs?: number; attemptTimeoutMs?: number } =
    {},
) {
  const provider = new ScriptedProvider('test', script);
  const events: BalancerEvent[] = [];
  const balancer = new LoadBalancer({
    providers: [provider],
    pools: {
      default: [{ provider: 'test', model: 'm1' }, { provider: 'test', model: 'm2' }],
      ocr: [{ provider: 'test', model: 'ocr' }],
    },
    health: options.health ?? { defaultCooldownSeconds: 60 },
    timeouts: {
      requestBudgetMs: options.requestBudgetMs ?? 5_000,
      attemptTimeoutMs: options.attemptTimeoutMs ?? 1_000,
    },
    onEvent: (event) => events.push(event),
  });
  return {
    balancer,
    provider,
    events,
    converse: () => balancer.model('default').converse(REQUEST),
  };
}

const failing = (kind: LlmProviderError['kind'], retryAfterSeconds?: number) => () => {
  throw new LlmProviderError({ kind, message: kind, retryAfterSeconds });
};

Deno.test('uses the first model when it succeeds', async () => {
  const { converse, provider } = createBalancer(() => 'ok');
  assertEquals(await converse(), 'ok');
  assertEquals(provider.models, ['m1']);
});

Deno.test('falls back to the next model when the first one fails', async () => {
  const { converse, provider } = createBalancer((model) => {
    if (model === 'm1') throw new Error('down');
    return 'from-2';
  });
  assertEquals(await converse(), 'from-2');
  assertEquals(provider.models, ['m1', 'm2']);
});

Deno.test('tries a healthy model first on the next request', async () => {
  const { converse, provider } = createBalancer((model) => {
    if (model === 'm1') throw new Error('down');
    return 'from-2';
  });
  await converse();
  await converse();
  assertEquals(provider.models, ['m1', 'm2', 'm2']);
});

Deno.test('each pool uses its own models', async () => {
  const { balancer, provider } = createBalancer(() => 'text');
  await balancer.model('ocr').converse(REQUEST);
  assertEquals(provider.models, ['ocr']);
});

Deno.test('passes the request to the provider unchanged', async () => {
  const { converse, provider } = createBalancer(() => 'ok');
  await converse();
  assertStrictEquals(provider.calls[0].request, REQUEST);
});

Deno.test('throws AllModelsFailedError listing every model when all fail', async () => {
  const { converse } = createBalancer(() => {
    throw new Error('down');
  });
  const err = await assertRejects(converse, AllModelsFailedError);
  assertEquals(err.pool, 'default');
  assertEquals(err.failures.map((f) => [f.model, f.kind, f.skipped]), [
    ['m1', 'unknown', false],
    ['m2', 'unknown', false],
  ]);
  assert(err.message.includes("All models failed for pool 'default'"));
});

Deno.test('aborts an attempt that exceeds the attempt timeout and falls back', async () => {
  const { converse, provider } = createBalancer(
    (model, signal) => {
      if (model !== 'm1') return 'late-ok';
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
    { attemptTimeoutMs: 50 },
  );
  assertEquals(await converse(), 'late-ok');
  assertEquals(provider.models, ['m1', 'm2']);
});

Deno.test('times out a provider that ignores the abort signal', async () => {
  const { converse, events } = createBalancer(
    (model) => (model === 'm1' ? hang() : 'ok'),
    { attemptTimeoutMs: 50 },
  );
  assertEquals(await converse(), 'ok');
  const failed = events.find((e) => e.type === 'attempt_failed');
  assertEquals(failed?.type === 'attempt_failed' && failed.data.kind, 'timeout');
});

Deno.test('models left when the request budget is used up are skipped', async () => {
  await withClock(async (advance) => {
    const { converse, provider } = createBalancer(
      (model) => {
        if (model === 'm1') {
          advance(10_000);
          throw new Error('slow failure');
        }
        return 'ok';
      },
      { requestBudgetMs: 5_000 },
    );
    const err = await assertRejects(converse, AllModelsFailedError);
    assertEquals(provider.models, ['m1']);
    assertEquals(err.failures[1], {
      provider: 'test',
      model: 'm2',
      kind: 'timeout',
      message: 'Skipped: request time budget exhausted',
      skipped: true,
    });
  });
});

Deno.test('blocked content ends the chain without a fallback or a cooldown', async () => {
  const { converse, provider } = createBalancer(() => {
    throw new LlmContentBlockedError('prompt: SAFETY');
  });
  await assertRejects(converse, LlmContentBlockedError);
  await assertRejects(converse, LlmContentBlockedError);
  assertEquals(provider.models, ['m1', 'm1']);
});

Deno.test('an ordinary failure keeps the model out only for the configured cooldown', async () => {
  let calls = 0;
  const { converse, provider } = createBalancer(
    (model) => {
      calls++;
      if (model === 'm1' && calls === 1) throw new Error('down');
      return 'ok';
    },
    { health: { defaultCooldownSeconds: 0 } },
  );
  await converse();
  await converse();
  assertEquals(provider.models, ['m1', 'm2', 'm1']);
});

Deno.test('the cooldown is configured per failure kind', async () => {
  let calls = 0;
  const { converse, provider } = createBalancer(
    (model) => {
      calls++;
      if (calls === 1) throw new LlmProviderError({ kind: 'overloaded', message: 'busy' });
      return model;
    },
    { health: { defaultCooldownSeconds: 60, byKind: { overloaded: { cooldownSeconds: 0 } } } },
  );
  await converse();
  assertEquals(await converse(), 'm1');
  assertEquals(provider.models, ['m1', 'm2', 'm1']);
});

Deno.test('a retry delay from the provider wins over a shorter cooldown', async () => {
  const { converse, provider } = createBalancer(
    (model) => (model === 'm1' ? failing('overloaded', 48678)() : 'ok'),
    { health: { defaultCooldownSeconds: 0 } },
  );
  await converse();
  await converse();
  assertEquals(provider.models, ['m1', 'm2', 'm2']);
});

Deno.test('models over their usage limit are skipped, not tried as a last resort', async () => {
  const { converse, provider } = createBalancer(failing('rate_limited', 48678));
  await assertRejects(converse, AllModelsFailedError);
  const err = await assertRejects(converse, AllModelsFailedError);

  assertEquals(provider.models, ['m1', 'm2']);
  assertEquals(err.failures.map((f) => [f.model, f.kind, f.skipped]), [
    ['m1', 'rate_limited', true],
    ['m2', 'rate_limited', true],
  ]);
});

Deno.test('a model that merely failed is still tried when nothing healthy is left', async () => {
  const { converse, provider } = createBalancer(failing('server_error'));
  await assertRejects(converse, AllModelsFailedError);
  await assertRejects(converse, AllModelsFailedError);
  assertEquals(provider.models, ['m1', 'm2', 'm1', 'm2']);
});

Deno.test('lastResort: false keeps any failure kind out until its cooldown ends', async () => {
  const { converse, provider } = createBalancer(failing('server_error'), {
    health: { byKind: { server_error: { lastResort: false } } },
  });
  await assertRejects(converse, AllModelsFailedError);
  await assertRejects(converse, AllModelsFailedError);
  assertEquals(provider.models, ['m1', 'm2']);
});

Deno.test('a model comes back after its cooldown', async () => {
  await withClock(async (advance) => {
    let down = true;
    const { converse, provider } = createBalancer((model) => {
      if (model === 'm1' && down) throw new Error('down');
      return model;
    });
    await converse();
    down = false;
    advance(59_000);
    assertEquals(await converse(), 'm2');
    advance(2_000);
    assertEquals(await converse(), 'm1');
    assertEquals(provider.models, ['m1', 'm2', 'm2', 'm1']);
  });
});

Deno.test('falls back across providers', async () => {
  const primary = new ScriptedProvider('primary', failing('auth'));
  const backup = new ScriptedProvider('backup', () => 'from backup');
  const balancer = new LoadBalancer({
    providers: [primary, backup],
    pools: { chat: [{ provider: 'primary', model: 'p' }, { provider: 'backup', model: 'b' }] },
  });
  assertEquals(await balancer.model('chat').converse(REQUEST), 'from backup');
});

Deno.test('pools that share a model share its health', async () => {
  const provider = new ScriptedProvider('test', (model) => {
    if (model === 'shared') throw new Error('down');
    return model;
  });
  const balancer = new LoadBalancer({
    providers: [provider],
    pools: {
      a: [{ provider: 'test', model: 'shared' }, { provider: 'test', model: 'a-only' }],
      b: [{ provider: 'test', model: 'shared' }, { provider: 'test', model: 'b-only' }],
    },
  });
  await balancer.model('a').converse(REQUEST);
  assertEquals(await balancer.model('b').converse(REQUEST), 'b-only');
  assertEquals(provider.models, ['shared', 'a-only', 'b-only']);
});

Deno.test('status reports cooling-down models and the pools that use them', async () => {
  const { balancer, converse } = createBalancer((model) => {
    if (model === 'm1') throw new LlmProviderError({ kind: 'rate_limited', message: 'quota' });
    return 'ok';
  });
  await converse();

  const status = await balancer.status();
  assertEquals(status.map((s) => [s.model, s.pools, s.healthy]), [
    ['m1', ['default'], false],
    ['m2', ['default'], true],
    ['ocr', ['ocr'], true],
  ]);
  assertEquals(status[0].cooldown?.kind, 'rate_limited');
  assertEquals(status[0].cooldown?.lastResort, false);
});

Deno.test('reports attempts, failures and the final error as events', async () => {
  const { converse, events } = createBalancer(failing('overloaded'));
  await assertRejects(converse, AllModelsFailedError);

  assertEquals(events.map((e) => `${e.level}:${e.type}`), [
    'info:attempt',
    'warn:attempt_failed',
    'info:attempt',
    'warn:attempt_failed',
    'error:all_models_failed',
  ]);
  assertEquals(events[1].data, {
    pool: 'default',
    provider: 'test',
    model: 'm1',
    kind: 'overloaded',
    cooldownSeconds: 60,
    lastResort: true,
    error: 'overloaded',
  });
});

Deno.test('a throwing event listener does not break the request', async () => {
  const balancer = new LoadBalancer({
    providers: [new ScriptedProvider('test', () => 'ok')],
    pools: { default: [{ provider: 'test', model: 'm' }] },
    onEvent: () => {
      throw new Error('logger down');
    },
  });
  assertEquals(await balancer.model('default').converse(REQUEST), 'ok');
});

Deno.test('keeps health in the given store', async () => {
  const records = new Map<string, HealthRecord>();
  const store = new MemoryHealthStore();
  const recordingStore = {
    get: (key: string) => store.get(key),
    set: (key: string, record: HealthRecord) => {
      records.set(key, record);
      return store.set(key, record);
    },
    delete: (key: string) => store.delete(key),
  };
  const balancer = new LoadBalancer({
    providers: [new ScriptedProvider('test', failing('not_found'))],
    pools: { default: [{ provider: 'test', model: 'm' }] },
    healthStore: recordingStore,
  });
  await assertRejects(() => balancer.model('default').converse(REQUEST), AllModelsFailedError);
  assertEquals([...records.keys()], ['test:m']);
  assertEquals(records.get('test:m')?.kind, 'not_found');
});
