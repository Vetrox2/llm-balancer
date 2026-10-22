import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from '@std/assert';
import { BalancerConfigError, LlmContentBlockedError, LlmProviderError } from '../mod.ts';
import { openAiCompatible } from '../src/providers/openai-compatible/mod.ts';
import { openRouter } from '../src/providers/openrouter/mod.ts';

const SIGNAL = new AbortController().signal;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const HI = { messages: [{ role: 'user' as const, content: 'hi' }] };

function fakeServer(response: () => Response) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(response());
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const completion = (message: unknown, finish_reason: string | null = 'stop') => () =>
  Response.json({ choices: [{ finish_reason, message }] });

function provider(response: () => Response) {
  const server = fakeServer(response);
  return {
    server,
    provider: openAiCompatible({
      name: 'acme',
      baseUrl: 'https://api.acme/v1/',
      fetch: server.fetch,
    }),
  };
}

Deno.test('sends a chat completion with the system prompt and images as data URLs', async () => {
  const server = fakeServer(completion({ content: 'cześć' }));
  const acme = openAiCompatible({
    name: 'acme',
    baseUrl: 'https://api.acme/v1/',
    apiKey: 'secret',
    headers: { 'X-Extra': '1' },
    fetch: server.fetch,
  });

  const text = await acme.converse(
    {
      system: 'rules',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: PNG }] },
      ],
      maxOutputTokens: 100,
    },
    'm',
    SIGNAL,
  );

  assertEquals(text, 'cześć');
  const [{ url, init }] = server.requests;
  assertEquals(url, 'https://api.acme/v1/chat/completions');
  assertStrictEquals(init.signal, SIGNAL);
  assertEquals(init.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer secret',
    'X-Extra': '1',
  });
  assertEquals(JSON.parse(String(init.body)), {
    model: 'm',
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
        ],
      },
    ],
    stream: false,
    max_tokens: 100,
  });
});

Deno.test('adds the extra body fields of the model, without overriding the request', async () => {
  const server = fakeServer(completion({ content: 'ok' }));
  const acme = openAiCompatible({
    name: 'acme',
    baseUrl: 'https://api.acme/v1',
    modelOptions: { m: { temperature: 0, model: 'other', stream: true } },
    fetch: server.fetch,
  });
  await acme.converse(HI, 'm', SIGNAL);
  await acme.converse(HI, 'n', SIGNAL);
  const [first, second] = server.requests.map(({ init }) => JSON.parse(String(init.body)));
  assertEquals([first.temperature, first.model, first.stream], [0, 'm', false]);
  assertEquals(second.temperature, undefined);
});

Deno.test('reads an answer given as an array of text parts', async () => {
  const { provider: acme } = provider(
    completion({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
  );
  assertEquals(await acme.converse(HI, 'm', SIGNAL), 'ab');
});

Deno.test('HTTP errors get the kind of their status and the server message', async () => {
  const { provider: acme } = provider(() =>
    Response.json({ error: { code: 503, message: 'busy' } }, { status: 503 })
  );
  const err = await assertRejects(() => acme.converse(HI, 'm', SIGNAL), LlmProviderError);
  assertEquals([err.kind, err.status], ['overloaded', 503]);
  assertEquals(err.message, 'acme answered with HTTP 503: {"error":{"code":503,"message":"busy"}}');
});

Deno.test('a rate limit waits for Retry-After', async () => {
  const { provider: acme } = provider(() =>
    new Response('slow down', { status: 429, headers: { 'Retry-After': '42' } })
  );
  const err = await assertRejects(() => acme.converse(HI, 'm', SIGNAL), LlmProviderError);
  assertEquals([err.kind, err.retryAfterSeconds], ['rate_limited', 42]);
});

Deno.test('a rate limit waits for the X-RateLimit-Reset that OpenRouter passes in metadata', async () => {
  const reset = Date.now() + 3_600_000;
  const { provider: acme } = provider(() =>
    Response.json({
      error: {
        code: 429,
        message: 'Rate limit exceeded: free-models-per-day',
        metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Reset': String(reset) } },
      },
    }, { status: 429 })
  );
  const err = await assertRejects(() => acme.converse(HI, 'm', SIGNAL), LlmProviderError);
  assertEquals(err.kind, 'rate_limited');
  assertEquals(Math.abs(err.retryAfterSeconds! - 3600) <= 1, true);
});

Deno.test('an error inside a 200 answer is classified by its code', async () => {
  for (
    const body of [{ error: { code: 502, message: 'upstream' } }, {
      choices: [{ error: { code: 429, message: 'limited' }, finish_reason: 'error' }],
    }]
  ) {
    const { provider: acme } = provider(() => Response.json(body));
    const err = await assertRejects(() => acme.converse(HI, 'm', SIGNAL), LlmProviderError);
    assertEquals(err.kind, body.error ? 'server_error' : 'rate_limited');
  }
});

Deno.test('content filters and refusals block the content', async () => {
  const answers = [
    completion({ content: '' }, 'content_filter'),
    completion({ content: null, refusal: 'I cannot help with that.' }),
    () =>
      Response.json({
        error: { code: 403, message: 'flagged', metadata: { reasons: ['violence'] } },
      }, { status: 403 }),
  ];
  for (const answer of answers) {
    const { provider: acme } = provider(answer);
    await assertRejects(() => acme.converse(HI, 'm', SIGNAL), LlmContentBlockedError);
  }
});

Deno.test('a 403 without moderation reasons is an auth failure', async () => {
  const { provider: acme } = provider(() =>
    Response.json({ error: { code: 403, message: 'key disabled' } }, { status: 403 })
  );
  const err = await assertRejects(() => acme.converse(HI, 'm', SIGNAL), LlmProviderError);
  assertEquals(err.kind, 'auth');
});

Deno.test('an empty or unreadable answer is an invalid response', async () => {
  const answers = [
    completion({ content: '   ' }),
    completion({ content: null }, 'length'),
    () => Response.json({ choices: [] }),
    () => new Response('<html>'),
  ];
  for (const answer of answers) {
    const { provider: acme } = provider(answer);
    const err = await assertRejects(() => acme.converse(HI, 'm', SIGNAL), LlmProviderError);
    assertEquals(err.kind, 'invalid_response');
  }
});

Deno.test('the factory needs a name and an http(s) base URL', () => {
  assertThrows(() => openAiCompatible({ name: '', baseUrl: 'https://a' }), BalancerConfigError);
  assertThrows(() => openAiCompatible({ name: 'a', baseUrl: 'api.acme' }), BalancerConfigError);
  const local = openAiCompatible({ name: 'lmstudio', baseUrl: 'http://localhost:1234/v1' });
  assertEquals(local.name, 'lmstudio');
});

Deno.test('openRouter() targets OpenRouter with the attribution headers', async () => {
  const server = fakeServer(completion({ content: 'ok' }));
  const provider = openRouter({
    apiKey: 'or-key',
    appUrl: 'https://app.example',
    appTitle: 'My App',
    reasoning: { 'thinkingmachines/inkling:free': { effort: 'low' } },
    fetch: server.fetch,
  });

  assertEquals(provider.name, 'openrouter');
  await provider.converse(HI, 'thinkingmachines/inkling:free', SIGNAL);
  const [{ url, init }] = server.requests;
  assertEquals(url, 'https://openrouter.ai/api/v1/chat/completions');
  assertEquals(init.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer or-key',
    'HTTP-Referer': 'https://app.example',
    'X-Title': 'My App',
  });
  assertEquals(JSON.parse(String(init.body)).reasoning, { effort: 'low' });
  assertThrows(() => openRouter({ apiKey: ' ' }), BalancerConfigError);
});
