# llm-balancer

A small load balancer for LLM providers. You describe **pools** of models (for example `default` and
`ocr`), ask for a pool, and call `converse`. The library tries the models in order, falls back when
one fails, keeps failing models on a cooldown and enforces time budgets — so your application code
never deals with retries, quotas or vendor error formats.

- Pools with automatic fallback, typed by name (`balancer.model('ocrr')` does not compile)
- Per-model health: cooldowns per failure kind, `Retry-After` from the vendor always respected
- Attempt timeout and a time budget for the whole request
- Built-in providers: Google Gemini, Ollama; plug in any other vendor with one small interface
- Event hook for logging; no content of requests or answers ever leaves through it
- No runtime-specific APIs in the core: works in Deno, Node, Bun, Supabase Edge Functions,
  Cloudflare Workers

## Installation

The package is published from tagged releases of this repository. In Deno, map it in `deno.json`:

```json
{
  "imports": {
    "@vetrox/llm-balancer": "https://raw.githubusercontent.com/Vetrox2/llm-balancer/v0.1.0/mod.ts",
    "@vetrox/llm-balancer/gemini": "https://raw.githubusercontent.com/Vetrox2/llm-balancer/v0.1.0/src/providers/gemini/mod.ts",
    "@vetrox/llm-balancer/ollama": "https://raw.githubusercontent.com/Vetrox2/llm-balancer/v0.1.0/src/providers/ollama/mod.ts",
    "@vetrox/llm-balancer/env": "https://raw.githubusercontent.com/Vetrox2/llm-balancer/v0.1.0/src/env.ts"
  }
}
```

Once the package is on [JSR](https://jsr.io), the same entry points are available as
`jsr:@vetrox/llm-balancer@0.1.0` (`deno add jsr:@vetrox/llm-balancer`, or
`npx jsr add @vetrox/llm-balancer` for Node).

| Entry point                   | Contents                                                  |
| ----------------------------- | --------------------------------------------------------- |
| `@vetrox/llm-balancer`        | `LoadBalancer`, errors, types, `MemoryHealthStore`        |
| `@vetrox/llm-balancer/gemini` | `gemini()`, `GeminiProvider` (depends on `@google/genai`) |
| `@vetrox/llm-balancer/ollama` | `ollama()`, `OllamaProvider` (no dependencies)            |
| `@vetrox/llm-balancer/env`    | `providersFromEnv()`                                      |

Import only the providers you use; the core has no vendor dependencies.

## Quick start

```ts
import { LoadBalancer } from '@vetrox/llm-balancer';
import { gemini } from '@vetrox/llm-balancer/gemini';

const balancer = new LoadBalancer({
  providers: [gemini({ apiKey: Deno.env.get('GEMINI_API_KEY')! })],
  pools: {
    default: [
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
    ],
    ocr: [{ provider: 'gemini', model: 'gemini-2.5-flash-lite' }],
  },
});

const answer = await balancer.model('default').converse({
  system: 'You are a concise assistant.',
  messages: [{ role: 'user', content: 'Name three prime numbers.' }],
});
```

Create the balancer **once** (at startup, or as a singleton in your DI container) and reuse it:
model health lives inside it.

## How a request is handled

`balancer.model(pool).converse(request)`:

1. Orders the pool's models: healthy ones first (in pool order), then unhealthy ones whose policy
   allows a **last resort**. Unhealthy models without it are skipped until their cooldown ends.
2. Calls each model with an `AbortSignal` that fires after `attemptTimeoutMs`, capped by what is
   left of `requestBudgetMs`. Models left when the budget is used up are skipped.
3. Returns the first answer and marks that model healthy.
4. A failed attempt puts the model on a cooldown chosen by the failure kind (see below) and moves on
   to the next model.
5. Content blocked by a vendor's safety filter (`LlmContentBlockedError`) stops immediately: the
   next model would most likely block it too, and the model is not at fault, so no cooldown.
6. When nothing answered, throws `AllModelsFailedError` with the reason for every model.

The same model may appear in several pools; its health is shared.

## Requests

```ts
interface ConverseRequest {
  system?: string; // trusted instructions, sent through the vendor's system channel
  messages: Array<{ role: 'user' | 'assistant'; content: string | Part[] }>;
  maxOutputTokens?: number;
}

type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; data: Uint8Array; mimeType?: string }; // MIME type detected when omitted
```

The request object is passed unchanged to every model in the chain. Images are base64-encoded once
per request, however many models are tried.

## Configuration

```ts
new LoadBalancer({
  providers: [gemini({ apiKey }), ollama({ baseUrl: 'http://localhost:11434' })],
  pools: {
    default: [
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'ollama', model: 'qwen2.5vl' },
    ],
  },
  health: {
    defaultCooldownSeconds: 90,
    byKind: {
      rate_limited: { cooldownSeconds: 60 },
      auth: { cooldownSeconds: Infinity },
      overloaded: { cooldownSeconds: 15, lastResort: true },
    },
  },
  timeouts: { requestBudgetMs: 60_000, attemptTimeoutMs: 25_000 },
  onEvent: (event) => console[event.level](event.type, event.data),
  healthStore: new MemoryHealthStore(),
});
```

| Option                          | Default                   | Meaning                                            |
| ------------------------------- | ------------------------- | -------------------------------------------------- |
| `providers`                     | required                  | Every provider the pools use; names must be unique |
| `pools`                         | required                  | Pool name → models in fallback order               |
| `health.defaultCooldownSeconds` | `60`                      | Cooldown for kinds without their own               |
| `health.byKind`                 | see below                 | Per-kind `cooldownSeconds` and `lastResort`        |
| `timeouts.requestBudgetMs`      | `60000`                   | Time for the whole fallback chain                  |
| `timeouts.attemptTimeoutMs`     | `25000`                   | Time for one model                                 |
| `onEvent`                       | none                      | Logging hook; exceptions thrown by it are ignored  |
| `healthStore`                   | `new MemoryHealthStore()` | Where model health is kept                         |

The configuration is validated in the constructor. An empty pool, a pool that lists a model twice, a
model of an unknown provider, two providers with the same name or an invalid number throw
`BalancerConfigError` at startup instead of failing on the first request.

### Failure kinds and health policy

Providers classify every failure. The kind decides how long the model is out and whether it may
still be tried as a last resort:

| Kind               | Typical cause                           | Last resort by default |
| ------------------ | --------------------------------------- | ---------------------- |
| `rate_limited`     | HTTP 429, quota used up                 | no                     |
| `auth`             | HTTP 401/403, bad key                   | no                     |
| `not_found`        | HTTP 404, unknown or unpulled model     | no                     |
| `overloaded`       | HTTP 503                                | yes                    |
| `timeout`          | attempt timeout, HTTP 408               | yes                    |
| `server_error`     | other HTTP 5xx                          | yes                    |
| `invalid_response` | empty or unreadable answer              | yes                    |
| `unknown`          | anything else, including network errors | yes                    |

Every kind uses `defaultCooldownSeconds` unless `byKind` overrides it. Fields left out of an
override keep their defaults. When the vendor says how long to wait (`retryAfterSeconds`, e.g.
Gemini's `RetryInfo` on a used-up daily quota), the cooldown is never shorter than that.

## Errors

| Thrown by                                    | Error                    | When                                                                         |
| -------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `new LoadBalancer()`                         | `BalancerConfigError`    | invalid configuration                                                        |
| `balancer.model(pool)`                       | `BalancerConfigError`    | pool not configured (only reachable without type checking)                   |
| `handle.converse()`                          | `AllModelsFailedError`   | no model answered; `failures` lists each model, `kind`, `message`, `skipped` |
| `handle.converse()`                          | `LlmContentBlockedError` | a vendor's safety filter blocked the content; `reason`                       |
| `gemini()`, `ollama()`, `providersFromEnv()` | `BalancerConfigError`    | missing API key, invalid base URL                                            |

`LlmProviderError` (with `kind`, `status`, `retryAfterSeconds`) is what providers throw; the
balancer catches it and reports it inside `AllModelsFailedError.failures`.

```ts
try {
  return await balancer.model('default').converse(request);
} catch (err) {
  if (err instanceof LlmContentBlockedError) return refuse(err.reason);
  if (err instanceof AllModelsFailedError) return serviceUnavailable(err.failures);
  throw err;
}
```

## Events and logging

`onEvent` receives a discriminated union with a suggested log `level`:

| `type`              | `level` | `data`                                                                        |
| ------------------- | ------- | ----------------------------------------------------------------------------- |
| `attempt`           | `info`  | `pool`, `provider`, `model`                                                   |
| `attempt_failed`    | `warn`  | `pool`, `provider`, `model`, `kind`, `cooldownSeconds`, `lastResort`, `error` |
| `content_blocked`   | `warn`  | `pool`, `provider`, `model`, `reason`                                         |
| `all_models_failed` | `error` | `pool`, `failures`                                                            |

Events never contain prompts, images or answers.

```ts
onEvent: ((e) => logger[e.level](`llm_${e.type}`, e.data));
```

## Health status

```ts
for (const model of await balancer.status()) {
  console.log(model.provider, model.model, model.pools, model.healthy, model.cooldown);
}
// gemini gemini-2.5-flash ['default'] false { kind: 'rate_limited', reason: '...', until: 1760961234000, lastResort: false }
```

`until` is epoch milliseconds (`Infinity` for a cooldown that lasts until the process restarts).

## Built-in providers

### Gemini

```ts
import { gemini } from '@vetrox/llm-balancer/gemini';
const provider = gemini({ apiKey }); // name: 'gemini'
```

`model` autocompletes known Gemini ids and accepts any other string. Status codes map to failure
kinds as in the table above; HTTP 429 carries the retry delay from Gemini's `RetryInfo`. Prompt or
answer blocks from Gemini's safety filters become `LlmContentBlockedError`. For tests, construct
`new GeminiProvider(models)` with your own implementation of `IGeminiModels`.

### Ollama

```ts
import { ollama } from '@vetrox/llm-balancer/ollama';
const provider = ollama({ baseUrl: 'http://localhost:11434' }); // name: 'ollama'
```

Uses `/api/chat`. A model that is not pulled answers 404 and becomes `not_found`. Pass `fetch` to
route requests through your own client.

### From environment variables

```ts
import { providersFromEnv } from '@vetrox/llm-balancer/env';
const providers = providersFromEnv(); // GEMINI_API_KEY -> gemini(), OLLAMA_BASE_URL -> ollama()
```

Reads `Deno.env` or `process.env`; pass your own getter (`providersFromEnv((name) => config[name])`)
for anything else. Variables that are set but invalid throw `BalancerConfigError`.

## Custom providers

Any vendor works through one interface:

```ts
interface ILlmProvider<Name extends string = string, Model extends string = string> {
  readonly name: Name;
  converse(request: ConverseRequest, model: Model, signal: AbortSignal): Promise<string>;
}
```

Rules for implementations:

- pass `signal` to your HTTP call (the balancer also stops waiting on its own when it fires);
- throw `LlmProviderError` with the most specific `kind` you can tell, and `retryAfterSeconds` when
  the vendor sends one; `failureKindForStatus(status)` covers the usual HTTP statuses;
- throw `LlmContentBlockedError` when the vendor's safety filter refused the content;
- throw `invalid_response` for an empty answer rather than returning `''`.

Example for xAI Grok (OpenAI-compatible chat API, text only):

```ts
import {
  type ConverseRequest,
  failureKindForStatus,
  type ILlmProvider,
  LlmProviderError,
} from '@vetrox/llm-balancer';

type GrokModel = 'grok-4' | 'grok-4-fast' | (string & {});

export class GrokProvider implements ILlmProvider<'grok', GrokModel> {
  readonly name = 'grok';

  constructor(private readonly apiKey: string) {}

  async converse(request: ConverseRequest, model: GrokModel, signal: AbortSignal): Promise<string> {
    const messages = [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.messages.map(({ role, content }) => ({
        role,
        content: typeof content === 'string'
          ? content
          : content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n'),
      })),
    ];

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: request.maxOutputTokens }),
      signal,
    });

    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new LlmProviderError({
        kind: failureKindForStatus(response.status),
        status: response.status,
        message: `Grok answered with HTTP ${response.status}`,
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
      });
    }

    const text = (await response.json()).choices?.[0]?.message?.content;
    if (!text) throw new LlmProviderError({ kind: 'invalid_response', message: 'Empty answer' });
    return text;
  }
}

const balancer = new LoadBalancer({
  providers: [gemini({ apiKey }), new GrokProvider(xaiKey)],
  pools: {
    default: [
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'grok', model: 'grok-4-fast' },
    ],
  },
});
```

Built-in and custom providers are treated exactly the same.

## Sharing health between processes

By default each balancer keeps health in memory, which is right for a single server or one
serverless isolate. To share cooldowns between instances, implement `IHealthStore`:

```ts
import type { HealthRecord, IHealthStore } from '@vetrox/llm-balancer';

class RedisHealthStore implements IHealthStore {
  constructor(private readonly redis: RedisClient) {}

  async get(key: string): Promise<HealthRecord | undefined> {
    const raw = await this.redis.get(`llm-health:${key}`);
    if (!raw) return undefined;
    const record = JSON.parse(raw);
    return { ...record, until: record.until ?? Infinity }; // JSON has no Infinity
  }

  async set(key: string, record: HealthRecord): Promise<void> {
    const ttl = Number.isFinite(record.until) ? { PXAT: record.until } : {};
    await this.redis.set(`llm-health:${key}`, JSON.stringify(record), ttl);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`llm-health:${key}`);
  }
}
```

Keys are `provider:model`. The balancer decides about expiry; the store only keeps records.

## Testing code that uses the balancer

Depend on the interfaces `ILoadBalancer<Pool>` / `IModelHandle` and give your tests a fake, or keep
the real `LoadBalancer` and register a scripted provider:

```ts
const fake: ILlmProvider<'gemini'> = {
  name: 'gemini',
  converse: (_request, model) => Promise.resolve(`answer from ${model}`),
};
const balancer = new LoadBalancer({
  providers: [fake],
  pools: { default: [{ provider: 'gemini', model: 'test-model' }] },
});
```

## Development

```sh
deno task check          # fmt, lint, type check, tests
deno publish --dry-run   # JSR readiness
```

Releases: bump `version` in `deno.json`, tag `vX.Y.Z` and push the tag.

## License

MIT
