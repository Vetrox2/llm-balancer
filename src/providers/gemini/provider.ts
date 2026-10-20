import { LlmContentBlockedError, LlmProviderError } from '../../errors.ts';
import { failureKindForStatus } from '../../http-status.ts';
import type { ConverseRequest, ILlmProvider, Message } from '../../types.ts';
import { ImageEncoder } from '../images.ts';
import {
  ApiError,
  type Content,
  type GenAiPart,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from './genai.ts';
import type { GeminiModel } from './models.ts';

/** The part of the `GoogleGenAI` client the provider uses (`new GoogleGenAI({ apiKey }).models`). */
export interface IGeminiModels {
  generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
}

/**
 * Google Gemini through `@google/genai`.
 *
 * Failures are reported as:
 * - {@link LlmProviderError} `rate_limited` for HTTP 429, with `retryAfterSeconds` read from
 *   Gemini's `RetryInfo` (or the "Please retry in 1h2m3s" text when the details are missing);
 * - {@link LlmProviderError} with the kind of any other HTTP status (see `failureKindForStatus`);
 * - {@link LlmProviderError} `invalid_response` for an empty answer;
 * - {@link LlmContentBlockedError} when Gemini's safety filters block the prompt or the answer.
 *
 * Network errors and aborts are passed on unchanged.
 */
export class GeminiProvider implements ILlmProvider<'gemini', GeminiModel> {
  readonly name = 'gemini';

  private static readonly BLOCKED_FINISH_REASONS: ReadonlySet<string> = new Set([
    'SAFETY',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
  ]);
  private static readonly RETRY_IN_TEXT = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i;

  private readonly images = new ImageEncoder();

  constructor(private readonly models: IGeminiModels) {}

  async converse(
    { system, messages, maxOutputTokens }: ConverseRequest,
    model: GeminiModel,
    signal: AbortSignal,
  ): Promise<string> {
    let response: GenerateContentResponse;
    try {
      response = await this.models.generateContent({
        model,
        contents: messages.map((message) => this.toContent(message)),
        config: { systemInstruction: system, maxOutputTokens, abortSignal: signal },
      });
    } catch (err) {
      throw err instanceof ApiError ? this.toProviderError(err) : err;
    }
    return this.readText(response);
  }

  private toContent({ role, content }: Message): Content {
    const parts: GenAiPart[] = typeof content === 'string'
      ? [{ text: content }]
      : content.map((part) =>
        part.type === 'text' ? { text: part.text } : {
          inlineData: {
            data: this.images.base64(part.data),
            mimeType: this.images.mimeType(part),
          },
        }
      );
    return { role: role === 'assistant' ? 'model' : 'user', parts };
  }

  private toProviderError(err: ApiError): LlmProviderError {
    const kind = failureKindForStatus(err.status);
    return new LlmProviderError({
      kind,
      message: err.message,
      status: err.status,
      retryAfterSeconds: kind === 'rate_limited' ? this.retryDelaySeconds(err.message) : undefined,
      cause: err,
    });
  }

  /**
   * Gemini puts the wait in `RetryInfo.retryDelay` ("48678s" for a used-up daily limit, a few
   * seconds for a per-minute one) and repeats it in the text ("Please retry in 13h31m18.9s.").
   */
  private retryDelaySeconds(message: string): number | undefined {
    const fromDetails = this.readRetryInfo(message);
    if (fromDetails !== undefined) return fromDetails;

    const match = message.match(GeminiProvider.RETRY_IN_TEXT);
    if (!match) return undefined;
    const [, hours = '0', minutes = '0', seconds = '0'] = match;
    return Math.ceil(Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds));
  }

  private readRetryInfo(message: string): number | undefined {
    try {
      const details: unknown = JSON.parse(message)?.error?.details;
      if (!Array.isArray(details)) return undefined;
      const retryDelay = details.find((d) => String(d?.['@type']).endsWith('RetryInfo'))
        ?.retryDelay;
      const seconds = Number.parseFloat(String(retryDelay));
      return Number.isFinite(seconds) ? Math.ceil(seconds) : undefined;
    } catch {
      return undefined;
    }
  }

  private readText(response: GenerateContentResponse): string {
    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) throw new LlmContentBlockedError(`prompt: ${blockReason}`);

    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && GeminiProvider.BLOCKED_FINISH_REASONS.has(finishReason)) {
      throw new LlmContentBlockedError(`answer: ${finishReason}`);
    }

    const text = response.text ?? '';
    if (!text.trim()) {
      throw new LlmProviderError({
        kind: 'invalid_response',
        message: `Gemini returned no text (finishReason: ${finishReason ?? 'none'})`,
      });
    }
    return text;
  }
}
