import { assertEquals, assertThrows } from '@std/assert';
import { BalancerConfigError } from '../mod.ts';
import { providersFromEnv } from '../src/env.ts';

const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

Deno.test('creates a provider for every configured service', () => {
  const providers = providersFromEnv(
    envOf({ GEMINI_API_KEY: 'key', OLLAMA_BASE_URL: 'http://localhost:11434' }),
  );
  assertEquals(providers.map((p) => p.name), ['gemini', 'ollama']);
});

Deno.test('skips services without configuration', () => {
  assertEquals(providersFromEnv(envOf({ GEMINI_API_KEY: ' ' })), []);
  assertEquals(providersFromEnv(envOf({ OLLAMA_BASE_URL: 'http://ollama' })).length, 1);
});

Deno.test('an invalid value fails loudly instead of being skipped', () => {
  assertThrows(
    () => providersFromEnv(envOf({ OLLAMA_BASE_URL: 'not a url' })),
    BalancerConfigError,
  );
});

Deno.test('reads the runtime environment by default', () => {
  Deno.env.set('GEMINI_API_KEY', 'from-env');
  Deno.env.delete('OLLAMA_BASE_URL');
  try {
    assertEquals(providersFromEnv().map((p) => p.name), ['gemini']);
  } finally {
    Deno.env.delete('GEMINI_API_KEY');
  }
});
