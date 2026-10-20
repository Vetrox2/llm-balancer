/**
 * Google Gemini provider.
 *
 * @example
 * ```ts
 * import { gemini } from '@vetrox/llm-balancer/gemini';
 * const provider = gemini({ apiKey: Deno.env.get('GEMINI_API_KEY')! });
 * ```
 *
 * @module
 */
import { BalancerConfigError } from '../../errors.ts';
import { GoogleGenAI } from './genai.ts';
import { GeminiProvider } from './provider.ts';

export { GeminiProvider, type IGeminiModels } from './provider.ts';
export type { GeminiModel } from './models.ts';

export interface GeminiOptions {
  apiKey: string;
}

/**
 * Creates the Gemini provider (name `'gemini'`).
 *
 * @throws {BalancerConfigError} when `apiKey` is empty.
 */
export function gemini({ apiKey }: GeminiOptions): GeminiProvider {
  if (!apiKey?.trim()) throw new BalancerConfigError('gemini() requires a non-empty apiKey');
  return new GeminiProvider(new GoogleGenAI({ apiKey }).models);
}
