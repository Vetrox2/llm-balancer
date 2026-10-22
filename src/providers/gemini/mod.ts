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
import type { GeminiModel, GeminiThinkingLevel } from './models.ts';
import { GeminiProvider } from './provider.ts';

export { GeminiProvider, type IGeminiModels } from './provider.ts';
export type { GeminiModel, GeminiThinkingLevel } from './models.ts';

export interface GeminiOptions {
  apiKey: string;
  /**
   * Thinking level per model, for example `{ 'gemma-4-31b-it': 'MINIMAL' }`. Models left out
   * use their default.
   */
  thinkingLevels?: Partial<Record<GeminiModel, GeminiThinkingLevel>>;
}

/**
 * Creates the Gemini provider (name `'gemini'`).
 *
 * @throws {BalancerConfigError} when `apiKey` is empty.
 */
export function gemini({ apiKey, thinkingLevels }: GeminiOptions): GeminiProvider {
  if (!apiKey?.trim()) throw new BalancerConfigError('gemini() requires a non-empty apiKey');
  return new GeminiProvider(new GoogleGenAI({ apiKey }).models, thinkingLevels);
}
