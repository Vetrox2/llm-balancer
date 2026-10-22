import { assert, assertEquals, assertRejects, assertStrictEquals, assertThrows } from '@std/assert';
import {
  BalancerConfigError,
  type ConverseRequest,
  LlmContentBlockedError,
  LlmProviderError,
} from '../mod.ts';
import { gemini, GeminiProvider, type IGeminiModels } from '../src/providers/gemini/mod.ts';
import {
  ApiError,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '../src/providers/gemini/genai.ts';

const REQUEST: ConverseRequest = { system: 'rules', messages: [{ role: 'user', content: 'data' }] };
const SIGNAL = new AbortController().signal;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

class FakeGeminiModels implements IGeminiModels {
  readonly calls: GenerateContentParameters[] = [];

  constructor(private readonly answer: Partial<GenerateContentResponse> | Error) {}

  generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> {
    this.calls.push(params);
    if (this.answer instanceof Error) return Promise.reject(this.answer);
    return Promise.resolve(this.answer as GenerateContentResponse);
  }
}

const answer = (text: string, finishReason = 'STOP') =>
  ({ text, candidates: [{ finishReason }] }) as Partial<GenerateContentResponse>;

function converse(models: IGeminiModels, request = REQUEST) {
  return new GeminiProvider(models).converse(request, 'm', SIGNAL);
}

Deno.test('returns the text and sends the system prompt as the system instruction', async () => {
  const models = new FakeGeminiModels(answer('odpowiedź'));
  assertEquals(await converse(models), 'odpowiedź');
  assertEquals(models.calls[0].config?.systemInstruction, 'rules');
  assertStrictEquals(models.calls[0].config?.abortSignal, SIGNAL);
});

Deno.test('sends the thinking level configured for the model, and none for other models', async () => {
  const models = new FakeGeminiModels(answer('ok'));
  const provider = new GeminiProvider(models, { 'gemma-4-31b-it': 'MINIMAL' });
  await provider.converse(REQUEST, 'gemma-4-31b-it', SIGNAL);
  await provider.converse(REQUEST, 'gemini-3.7-flash', SIGNAL);
  assertEquals(models.calls[0].config?.thinkingConfig?.thinkingLevel, 'MINIMAL');
  assertEquals(models.calls[1].config?.thinkingConfig, undefined);
});

Deno.test('maps messages to Gemini contents, with images inline', async () => {
  const models = new FakeGeminiModels(answer('ok'));
  await converse(models, {
    system: 's',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', data: JPEG },
          { type: 'image', data: JPEG, mimeType: 'image/heic' },
        ],
      },
    ],
  });

  assertEquals(models.calls[0].contents, [
    { role: 'user', parts: [{ text: 'hi' }] },
    { role: 'model', parts: [{ text: 'hello' }] },
    {
      role: 'user',
      parts: [
        { text: 'look' },
        { inlineData: { data: '/9j/4AEC', mimeType: 'image/jpeg' } },
        { inlineData: { data: '/9j/4AEC', mimeType: 'image/heic' } },
      ],
    },
  ]);
});

Deno.test('a blocked prompt is reported as blocked content, not as an empty answer', async () => {
  const models = new FakeGeminiModels(
    {
      text: undefined,
      promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
    } as Partial<GenerateContentResponse>,
  );
  const err = await assertRejects(() => converse(models), LlmContentBlockedError);
  assert(err.reason.includes('PROHIBITED_CONTENT'));
});

Deno.test('an answer stopped by a safety filter is reported as blocked content', async () => {
  for (const finishReason of ['SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY']) {
    await assertRejects(
      () => converse(new FakeGeminiModels(answer('', finishReason))),
      LlmContentBlockedError,
    );
  }
});

Deno.test('an empty answer for another reason is an invalid response', async () => {
  const err = await assertRejects(
    () => converse(new FakeGeminiModels(answer('', 'MAX_TOKENS'))),
    LlmProviderError,
  );
  assertEquals(err.kind, 'invalid_response');
  assert(err.message.includes('MAX_TOKENS'));
});

/** Shape of the body Gemini sent when the free-tier daily limit ran out (2026-10-06). */
const DAILY_LIMIT_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      'You exceeded your current quota.\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 20\nPlease retry in 13h31m18.949937853s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '48678s' },
    ],
  },
});

Deno.test('a used-up limit is rate_limited with the retry delay Gemini gave', async () => {
  const models = new FakeGeminiModels(new ApiError({ message: DAILY_LIMIT_BODY, status: 429 }));
  const err = await assertRejects(() => converse(models), LlmProviderError);
  assertEquals(err.kind, 'rate_limited');
  assertEquals(err.status, 429);
  assertEquals(err.retryAfterSeconds, 48678);
});

Deno.test('the retry delay is read from the text when the details are missing', async () => {
  const message = 'Quota exceeded. Please retry in 1h2m3.5s.';
  const models = new FakeGeminiModels(new ApiError({ message, status: 429 }));
  const err = await assertRejects(() => converse(models), LlmProviderError);
  assertEquals(err.retryAfterSeconds, 3724);
});

Deno.test('other API errors are classified by their HTTP status', async () => {
  const expected: Array<[number, LlmProviderError['kind']]> = [
    [503, 'overloaded'],
    [500, 'server_error'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [400, 'unknown'],
  ];
  for (const [status, kind] of expected) {
    const apiError = new ApiError({ message: 'x', status });
    const err = await assertRejects(
      () => converse(new FakeGeminiModels(apiError)),
      LlmProviderError,
    );
    assertEquals([status, err.kind, err.retryAfterSeconds], [status, kind, undefined]);
    assertStrictEquals(err.cause, apiError);
  }
});

Deno.test('errors that are not API errors are passed on unchanged', async () => {
  const network = new TypeError('fetch failed');
  const err = await assertRejects(() => converse(new FakeGeminiModels(network)));
  assertStrictEquals(err, network);
});

Deno.test('the factory needs an API key', () => {
  assertThrows(() => gemini({ apiKey: ' ' }), BalancerConfigError);
  assertEquals(gemini({ apiKey: 'key' }).name, 'gemini');
});
