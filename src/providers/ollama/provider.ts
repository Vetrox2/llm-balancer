import { LlmProviderError } from '../../errors.ts';
import { failureKindForStatus } from '../../http-status.ts';
import type { ConverseRequest, ILlmProvider, Message } from '../../types.ts';
import { ImageEncoder } from '../images.ts';

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

/**
 * A local or self-hosted Ollama server through its `/api/chat` endpoint.
 *
 * Failures are reported as {@link LlmProviderError}: HTTP errors with the kind of their status
 * (404 = model not pulled = `not_found`), an empty or unreadable answer as `invalid_response`.
 * Network errors (server not running) and aborts are passed on unchanged.
 */
export class OllamaProvider implements ILlmProvider<'ollama'> {
  readonly name = 'ollama';

  private static readonly ERROR_BODY_PREVIEW_LENGTH = 300;

  private readonly images = new ImageEncoder();
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async converse(
    { system, messages, maxOutputTokens }: ConverseRequest,
    model: string,
    signal: AbortSignal,
  ): Promise<string> {
    const chat: OllamaChatMessage[] = system ? [{ role: 'system', content: system }] : [];
    chat.push(...messages.map((message) => this.toChatMessage(message)));

    const response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: chat,
        stream: false,
        ...(maxOutputTokens ? { options: { num_predict: maxOutputTokens } } : {}),
      }),
      signal,
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, OllamaProvider.ERROR_BODY_PREVIEW_LENGTH);
      throw new LlmProviderError({
        kind: failureKindForStatus(response.status),
        status: response.status,
        message: `Ollama answered with HTTP ${response.status}: ${body}`,
      });
    }
    return this.readText(response);
  }

  private toChatMessage({ role, content }: Message): OllamaChatMessage {
    if (typeof content === 'string') return { role, content };

    const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');
    const images = content.flatMap((part) =>
      part.type === 'image' ? [this.images.base64(part.data)] : []
    );
    return images.length > 0 ? { role, content: text, images } : { role, content: text };
  }

  private async readText(response: Response): Promise<string> {
    let text: unknown;
    try {
      text = ((await response.json()) as { message?: { content?: unknown } }).message?.content;
    } catch (err) {
      throw new LlmProviderError({
        kind: 'invalid_response',
        message: 'Ollama returned invalid JSON',
        cause: err,
      });
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new LlmProviderError({ kind: 'invalid_response', message: 'Ollama returned no text' });
    }
    return text;
  }
}
