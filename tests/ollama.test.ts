import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from '@std/assert';
import { BalancerConfigError, LlmProviderError } from '../mod.ts';
import { ollama } from '../src/providers/ollama/mod.ts';

const SIGNAL = new AbortController().signal;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function fakeServer(response: () => Response) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(response());
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const chatAnswer = (content: unknown) => () => Response.json({ message: { content } });

Deno.test('sends a chat request and returns the answer', async () => {
  const server = fakeServer(chatAnswer('cześć'));
  const provider = ollama({ baseUrl: 'http://localhost:11434/', fetch: server.fetch });

  const text = await provider.converse(
    {
      system: 'rules',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'a' }, { type: 'image', data: PNG }, {
          type: 'text',
          text: 'b',
        }],
      }],
      maxOutputTokens: 100,
    },
    'llava',
    SIGNAL,
  );

  assertEquals(text, 'cześć');
  const [{ url, init }] = server.requests;
  assertEquals(url, 'http://localhost:11434/api/chat');
  assertStrictEquals(init.signal, SIGNAL);
  assertEquals(JSON.parse(String(init.body)), {
    model: 'llava',
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'a\n\nb', images: ['iVBORw=='] },
    ],
    stream: false,
    options: { num_predict: 100 },
  });
});

Deno.test('a model that is not pulled is not_found, with the server message', async () => {
  const server = fakeServer(() => Response.json({ error: "model 'x' not found" }, { status: 404 }));
  const provider = ollama({ baseUrl: 'http://ollama', fetch: server.fetch });

  const err = await assertRejects(
    () => provider.converse({ messages: [{ role: 'user', content: 'hi' }] }, 'x', SIGNAL),
    LlmProviderError,
  );
  assertEquals([err.kind, err.status], ['not_found', 404]);
  assertEquals(err.message, 'Ollama answered with HTTP 404: {"error":"model \'x\' not found"}');
});

Deno.test('an empty or unreadable answer is an invalid response', async () => {
  for (const response of [chatAnswer(''), chatAnswer(undefined), () => new Response('<html>')]) {
    const provider = ollama({ baseUrl: 'http://ollama', fetch: fakeServer(response).fetch });
    const err = await assertRejects(
      () => provider.converse({ messages: [{ role: 'user', content: 'hi' }] }, 'm', SIGNAL),
      LlmProviderError,
    );
    assertEquals(err.kind, 'invalid_response');
  }
});

Deno.test('the factory needs an http(s) base URL', () => {
  assertThrows(() => ollama({ baseUrl: 'localhost:11434' }), BalancerConfigError);
  assertThrows(() => ollama({ baseUrl: '' }), BalancerConfigError);
  assertEquals(ollama({ baseUrl: 'https://ollama.example' }).name, 'ollama');
});
