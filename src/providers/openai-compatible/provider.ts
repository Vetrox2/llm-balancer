import { LlmContentBlockedError, LlmProviderError } from '../../errors.ts';
import { failureKindForStatus } from '../../http-status.ts';
import type { ConverseRequest, ILlmProvider, Message } from '../../types.ts';
import { ImageEncoder } from '../images.ts';

type ChatContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
  metadata?: { headers?: Record<string, unknown>; reasons?: unknown };
}

interface ChatCompletion {
  error?: ApiErrorBody;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: unknown; refusal?: unknown };
    error?: ApiErrorBody;
  }>;
}

/** Settings of an {@link OpenAiCompatibleProvider}. */
export interface OpenAiCompatibleConfig<Name extends string = string> {
  /** The provider name referenced by `pools`. */
  name: Name;
  /** The API root that `/chat/completions` is appended to, for example `https://api.mistral.ai/v1`. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>`; omit it for servers without authentication. */
  apiKey?: string;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /**
   * Extra request-body fields per model, for vendor options such as OpenRouter's `reasoning`.
   * They cannot replace `model`, `messages`, `stream` or `max_tokens`.
   */
  modelOptions?: Partial<Record<string, Record<string, unknown>>>;
  /** Replaces the global `fetch` (proxies, tests). */
  fetch?: typeof fetch;
}

/**
 * Any server with an OpenAI-compatible `/chat/completions` endpoint (OpenRouter, Mistral, Groq,
 * NVIDIA NIM, vLLM, LM Studio, ...).
 *
 * Images are sent as `image_url` parts with a base64 data URL. Failures are reported as:
 * - {@link LlmProviderError} with the kind of the HTTP status (see `failureKindForStatus`), also
 *   when the server puts an error with a status code in a 200 answer; for `rate_limited`,
 *   `retryAfterSeconds` comes from the `Retry-After` or `X-RateLimit-Reset` header;
 * - {@link LlmProviderError} `invalid_response` for an empty or unreadable answer, or one cut off
 *   by the token limit before any text;
 * - {@link LlmContentBlockedError} for `finish_reason: "content_filter"`, a refusal, or a request
 *   rejected by the server's moderation.
 *
 * Network errors and aborts are passed on unchanged.
 */
export class OpenAiCompatibleProvider<Name extends string = string, Model extends string = string>
  implements ILlmProvider<Name, Model> {
  readonly name: Name;

  private static readonly ERROR_BODY_PREVIEW_LENGTH = 300;

  private readonly images = new ImageEncoder();
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;
  private readonly modelOptions: Partial<Record<string, Record<string, unknown>>>;

  constructor(
    { name, baseUrl, apiKey, headers, modelOptions, fetch: fetchFn }: OpenAiCompatibleConfig<Name>,
  ) {
    this.name = name;
    this.modelOptions = modelOptions ?? {};
    this.url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    };
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  async converse(
    { system, messages, maxOutputTokens }: ConverseRequest,
    model: Model,
    signal: AbortSignal,
  ): Promise<string> {
    const chat: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
    chat.push(...messages.map((message) => this.toChatMessage(message)));

    const response = await this.fetchFn(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        ...this.modelOptions[model],
        model,
        messages: chat,
        stream: false,
        ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
      }),
      signal,
    });

    if (!response.ok) throw await this.httpError(response);
    return this.readText(response);
  }

  private toChatMessage({ role, content }: Message): ChatMessage {
    if (typeof content === 'string') return { role, content };
    return {
      role,
      content: content.map((part) =>
        part.type === 'text' ? { type: 'text', text: part.text } : {
          type: 'image_url',
          image_url: {
            url: `data:${this.images.mimeType(part)};base64,${this.images.base64(part.data)}`,
          },
        }
      ),
    };
  }

  private async httpError(response: Response): Promise<Error> {
    const body = await response.text();
    let error: ApiErrorBody | undefined;
    try {
      error = (JSON.parse(body) as ChatCompletion).error;
    } catch {
      // not JSON: only the status is known
    }
    const preview = body.slice(0, OpenAiCompatibleProvider.ERROR_BODY_PREVIEW_LENGTH);
    if (this.isModerationBlock(response.status, error)) {
      return new LlmContentBlockedError(`prompt: ${preview}`);
    }
    return this.providerError(
      response.status,
      `${this.name} answered with HTTP ${response.status}: ${preview}`,
      response.headers,
      error,
    );
  }

  /** OpenRouter answers 403 with `metadata.reasons` when its moderation flags the input. */
  private isModerationBlock(status: number, error: ApiErrorBody | undefined): boolean {
    return status === 403 && Array.isArray(error?.metadata?.reasons);
  }

  private providerError(
    status: number,
    message: string,
    headers?: Headers,
    error?: ApiErrorBody,
  ): LlmProviderError {
    const kind = failureKindForStatus(status);
    return new LlmProviderError({
      kind,
      status,
      message,
      retryAfterSeconds: kind === 'rate_limited'
        ? this.retryDelaySeconds(headers, error)
        : undefined,
    });
  }

  /**
   * `Retry-After` holds seconds or an HTTP date. OpenRouter passes the upstream limit headers in
   * `error.metadata.headers`, where `X-RateLimit-Reset` is a Unix time in milliseconds.
   */
  private retryDelaySeconds(headers?: Headers, error?: ApiErrorBody): number | undefined {
    const upstream = error?.metadata?.headers ?? {};
    const retryAfter = headers?.get('retry-after') ?? this.header(upstream, 'retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
    }
    const reset = Number(
      headers?.get('x-ratelimit-reset') ?? this.header(upstream, 'x-ratelimit-reset'),
    );
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(0, Math.ceil((reset - Date.now()) / 1000));
    }
    return undefined;
  }

  private header(headers: Record<string, unknown>, name: string): string | undefined {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key === undefined ? undefined : String(headers[key]);
  }

  private async readText(response: Response): Promise<string> {
    let completion: ChatCompletion;
    try {
      completion = (await response.json()) as ChatCompletion;
    } catch (err) {
      throw new LlmProviderError({
        kind: 'invalid_response',
        message: `${this.name} returned invalid JSON`,
        cause: err,
      });
    }

    const choice = completion.choices?.[0];
    const error = completion.error ?? choice?.error;
    if (error) {
      const status = Number(error.code);
      throw this.providerError(
        Number.isInteger(status) ? status : 0,
        `${this.name} returned an error: ${String(error.message ?? '').slice(0, 300)}`,
        undefined,
        error,
      );
    }

    const finishReason = choice?.finish_reason;
    if (finishReason === 'content_filter') {
      throw new LlmContentBlockedError('answer: content_filter');
    }
    if (typeof choice?.message?.refusal === 'string' && choice.message.refusal.trim()) {
      throw new LlmContentBlockedError('answer: refusal');
    }

    const text = this.messageText(choice?.message?.content);
    if (!text.trim()) {
      throw new LlmProviderError({
        kind: 'invalid_response',
        message: `${this.name} returned no text (finish_reason: ${finishReason ?? 'none'})`,
      });
    }
    return text;
  }

  /** `content` is a string, or an array of parts on some servers. */
  private messageText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .flatMap((
        part,
      ) => (part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
      .join('');
  }
}
