import type { ConverseRequest, ILlmProvider } from '../../mod.ts';

export type Script = (
  model: string,
  signal: AbortSignal,
  request: ConverseRequest,
) => string | Promise<string>;

/** A provider whose answers come from a test script; records every call. */
export class ScriptedProvider<Name extends string = 'test'> implements ILlmProvider<Name> {
  readonly calls: Array<{ model: string; request: ConverseRequest }> = [];

  constructor(readonly name: Name, private readonly script: Script) {}

  async converse(request: ConverseRequest, model: string, signal: AbortSignal): Promise<string> {
    this.calls.push({ model, request });
    return await this.script(model, signal, request);
  }

  get models(): string[] {
    return this.calls.map((call) => call.model);
  }
}

/** Never settles, even when aborted: a provider that ignores the abort signal. */
export function hang(): Promise<string> {
  return new Promise<string>(() => {});
}
