/**
 * OpenRouter provider: hundreds of models from many vendors behind one API key.
 *
 * @example
 * ```ts
 * import { openRouter } from '@vetrox/llm-balancer/openrouter';
 * const provider = openRouter({ apiKey: Deno.env.get('OPENROUTER_API_KEY')! });
 * ```
 *
 * @module
 */
import { BalancerConfigError } from '../../errors.ts';
import type { OpenAiCompatibleProvider } from '../openai-compatible/provider.ts';
import { openAiCompatible } from '../openai-compatible/mod.ts';

/**
 * OpenRouter model ids, for autocompletion in `pools`. Any other string is accepted too. Free
 * variants end with `:free`; OpenRouter adds and removes them without notice.
 */
export type OpenRouterModel =
  | 'openrouter/free'
  | 'google/gemma-4-31b-it:free'
  | 'google/gemma-4-26b-a4b-it:free'
  | 'minimax/minimax-m3.1-flash:free'
  | 'nvidia/nemotron-3.5-super-vl:free'
  | 'thinkingmachines/inkling:free'
  | 'thinkingmachines/inkling-small:free'
  // deno-lint-ignore ban-types
  | (string & {});

/**
 * How much a reasoning model thinks before answering
 * ([docs](https://openrouter.ai/docs/use-cases/reasoning-tokens)). Free reasoning models can think
 * for minutes on a long prompt; `effort: 'low'` or `enabled: false` answers much faster. Models that
 * do not support an option ignore it.
 */
export interface OpenRouterReasoning {
  effort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Upper limit for reasoning tokens (instead of `effort`). */
  max_tokens?: number;
  /** `false` turns reasoning off where the model allows it. */
  enabled?: boolean;
}

export interface OpenRouterOptions {
  apiKey: string;
  /** Your site URL, sent as `HTTP-Referer` for OpenRouter's app attribution. */
  appUrl?: string;
  /** Your app name, sent as `X-Title` for OpenRouter's app attribution. */
  appTitle?: string;
  /** Reasoning settings per model; models left out use OpenRouter's default. */
  reasoning?: Partial<Record<OpenRouterModel, OpenRouterReasoning>>;
  /** Replaces the global `fetch` (proxies, tests). */
  fetch?: typeof fetch;
}

/** The OpenRouter provider: an {@link OpenAiCompatibleProvider} named `'openrouter'`. */
export type OpenRouterProvider = OpenAiCompatibleProvider<'openrouter', OpenRouterModel>;

/**
 * Creates the OpenRouter provider (name `'openrouter'`).
 *
 * A used-up daily limit of free models (HTTP 429) is reported as `rate_limited` with
 * `retryAfterSeconds` until the limit resets.
 *
 * @throws {BalancerConfigError} when `apiKey` is empty.
 */
export function openRouter(
  { apiKey, appUrl, appTitle, reasoning = {}, fetch }: OpenRouterOptions,
): OpenRouterProvider {
  if (!apiKey?.trim()) throw new BalancerConfigError('openRouter() requires a non-empty apiKey');
  return openAiCompatible<'openrouter', OpenRouterModel>({
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    headers: {
      ...(appUrl ? { 'HTTP-Referer': appUrl } : {}),
      ...(appTitle ? { 'X-Title': appTitle } : {}),
    },
    modelOptions: Object.fromEntries(
      Object.entries(reasoning).map(([model, settings]) => [model, { reasoning: settings }]),
    ),
    fetch,
  });
}
