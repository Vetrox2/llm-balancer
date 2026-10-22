/**
 * Gemini model ids, for autocompletion in `pools`. Any other string is accepted too, so a model
 * released after this version of the library works without an update.
 */
export type GeminiModel =
  | 'gemini-3-flash-preview'
  | 'gemini-3.8-flash'
  | 'gemini-3.7-flash'
  | 'gemini-3.6-flash'
  | 'gemini-3.5-flash'
  | 'gemini-3.5-flash-lite'
  | 'gemini-3.1-flash-lite'
  | 'gemini-2.5-pro'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-lite'
  | 'gemma-4-31b-it'
  | 'gemma-4-26b-a4b-it'
  // deno-lint-ignore ban-types
  | (string & {});

/**
 * How much a model thinks before answering. Less thinking answers faster: Gemma 4 with its default
 * thinking can take minutes for a long prompt. Not every model accepts every level (Gemma 4 takes
 * `MINIMAL` but not `LOW`); an unsupported level is rejected by the API with HTTP 400.
 */
export type GeminiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
