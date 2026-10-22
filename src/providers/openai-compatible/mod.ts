/**
 * Provider for any server with an OpenAI-compatible `/chat/completions` endpoint.
 *
 * @example
 * ```ts
 * import { openAiCompatible } from '@vetrox/llm-balancer/openai-compatible';
 * const provider = openAiCompatible({
 *   name: 'mistral',
 *   baseUrl: 'https://api.mistral.ai/v1',
 *   apiKey: Deno.env.get('MISTRAL_API_KEY')!,
 * });
 * ```
 *
 * @module
 */
import { BalancerConfigError } from '../../errors.ts';
import { type OpenAiCompatibleConfig, OpenAiCompatibleProvider } from './provider.ts';

export { type OpenAiCompatibleConfig, OpenAiCompatibleProvider } from './provider.ts';

/**
 * Creates a provider for an OpenAI-compatible API under the given `name`.
 *
 * @typeParam Model - Model identifiers for autocompletion in `pools`; any string by default.
 * @throws {BalancerConfigError} when `name` is empty or `baseUrl` is not a valid http(s) URL.
 */
export function openAiCompatible<Name extends string, Model extends string = string>(
  config: OpenAiCompatibleConfig<Name>,
): OpenAiCompatibleProvider<Name, Model> {
  if (!config.name?.trim()) {
    throw new BalancerConfigError('openAiCompatible() requires a non-empty name');
  }
  const { baseUrl } = config;
  if (!URL.canParse(baseUrl) || !/^https?:$/.test(new URL(baseUrl).protocol)) {
    throw new BalancerConfigError(
      `openAiCompatible() requires an http(s) baseUrl, got '${baseUrl}'`,
    );
  }
  return new OpenAiCompatibleProvider<Name, Model>(config);
}
