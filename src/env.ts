/**
 * Builds providers from environment variables. A convenience: passing providers explicitly to
 * `LoadBalancer` stays the main way.
 *
 * @module
 */
import { gemini } from './providers/gemini/mod.ts';
import type { GeminiProvider } from './providers/gemini/provider.ts';
import { ollama } from './providers/ollama/mod.ts';
import type { OllamaProvider } from './providers/ollama/provider.ts';
import { openRouter, type OpenRouterProvider } from './providers/openrouter/mod.ts';

/** Reads one variable; returns `undefined` (or an empty string) when it is not set. */
export type EnvGetter = (name: string) => string | undefined;

/**
 * Returns a provider for every service configured in the environment:
 * `GEMINI_API_KEY` -> `gemini()`, `OLLAMA_BASE_URL` -> `ollama()`,
 * `OPENROUTER_API_KEY` -> `openRouter()`.
 *
 * @param get Defaults to `Deno.env.get`, or `process.env` outside Deno.
 * @throws {BalancerConfigError} when a variable is set but invalid (for example a malformed URL).
 */
export function providersFromEnv(
  get: EnvGetter = readRuntimeEnv,
): Array<GeminiProvider | OllamaProvider | OpenRouterProvider> {
  const providers: Array<GeminiProvider | OllamaProvider | OpenRouterProvider> = [];

  const apiKey = get('GEMINI_API_KEY')?.trim();
  if (apiKey) providers.push(gemini({ apiKey }));

  const baseUrl = get('OLLAMA_BASE_URL')?.trim();
  if (baseUrl) providers.push(ollama({ baseUrl }));

  const openRouterKey = get('OPENROUTER_API_KEY')?.trim();
  if (openRouterKey) providers.push(openRouter({ apiKey: openRouterKey }));

  return providers;
}

function readRuntimeEnv(name: string): string | undefined {
  const runtime = globalThis as unknown as {
    Deno?: { env: { get(name: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  return runtime.Deno ? runtime.Deno.env.get(name) : runtime.process?.env[name];
}
