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
  // deno-lint-ignore ban-types
  | (string & {});
