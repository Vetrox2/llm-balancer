/**
 * Ollama provider.
 *
 * @example
 * ```ts
 * import { ollama } from '@vetrox/llm-balancer/ollama';
 * const provider = ollama({ baseUrl: 'http://localhost:11434' });
 * ```
 *
 * @module
 */
import { BalancerConfigError } from '../../errors.ts';
import { OllamaProvider } from './provider.ts';

export { OllamaProvider } from './provider.ts';

export interface OllamaOptions {
  /** The server root, for example `http://localhost:11434`. */
  baseUrl: string;
  /** Replaces the global `fetch` (proxies, tests). */
  fetch?: typeof fetch;
}

/**
 * Creates the Ollama provider (name `'ollama'`).
 *
 * @throws {BalancerConfigError} when `baseUrl` is not a valid http(s) URL.
 */
export function ollama({ baseUrl, fetch }: OllamaOptions): OllamaProvider {
  if (!URL.canParse(baseUrl) || !/^https?:$/.test(new URL(baseUrl).protocol)) {
    throw new BalancerConfigError(`ollama() requires an http(s) baseUrl, got '${baseUrl}'`);
  }
  return new OllamaProvider(baseUrl, fetch);
}
