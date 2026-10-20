/** Plain text inside a message. */
export interface TextPart {
  type: 'text';
  text: string;
}

/**
 * Raw image bytes inside a message. Providers that need a MIME type detect it from the bytes
 * (PNG, JPEG, WebP, GIF) when `mimeType` is omitted.
 */
export interface ImagePart {
  type: 'image';
  data: Uint8Array;
  mimeType?: string;
}

export type Part = TextPart | ImagePart;

export type Role = 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string | Part[];
}

/** One provider-agnostic generation request. The same object is replayed on every fallback model. */
export interface ConverseRequest {
  /** Trusted instructions sent through the provider's dedicated system channel. */
  system?: string;
  messages: Message[];
  /** Upper limit for generated tokens; thinking models count reasoning tokens towards it too. */
  maxOutputTokens?: number;
}

/**
 * A backend that can answer a {@link ConverseRequest} with one of its models. Implement it to plug
 * in any vendor; built-in and custom providers are treated the same way.
 *
 * Failures should be reported as {@link LlmProviderError} with the most specific `kind` the
 * provider can tell, so the balancer can apply the matching health policy. Content refused by the
 * vendor's safety filter should be reported as {@link LlmContentBlockedError}, which ends the
 * fallback chain. Any other thrown value is treated as a failure of kind `unknown`.
 *
 * @typeParam Name - The provider name referenced by `pools` (for example `'gemini'`).
 * @typeParam Model - Model identifiers the provider accepts; drives autocompletion in `pools`.
 */
export interface ILlmProvider<Name extends string = string, Model extends string = string> {
  readonly name: Name;
  /**
   * @param signal Aborted when the attempt timeout or the request budget runs out. Pass it to the
   *   underlying HTTP call so the attempt stops promptly.
   * @returns The generated text. An empty answer should be thrown as `invalid_response`.
   */
  converse(request: ConverseRequest, model: Model, signal: AbortSignal): Promise<string>;
}

/** Points at one model of one provider. */
export interface ModelRef<Provider extends string = string, Model extends string = string> {
  provider: Provider;
  model: Model;
}

/** The model references allowed for a set of providers: `model` is typed by its `provider`. */
export type ModelRefOf<P extends ILlmProvider> = P extends ILlmProvider<infer N, infer M>
  ? ModelRef<N, M>
  : never;
