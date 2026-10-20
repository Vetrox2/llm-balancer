// Compile-time checks: `deno check` / `deno test` fail when an expected type error disappears.
import { LoadBalancer } from '../mod.ts';
import { ScriptedProvider } from './testing/scripted-provider.ts';

Deno.test('pool and provider names are checked by the compiler', () => {
  const alpha = new ScriptedProvider('alpha', () => 'ok');
  const beta = new ScriptedProvider('beta', () => 'ok');

  const balancer = new LoadBalancer({
    providers: [alpha, beta],
    pools: {
      default: [{ provider: 'alpha', model: 'a' }, { provider: 'beta', model: 'b' }],
      ocr: [{ provider: 'beta', model: 'b' }],
    },
  });

  const compileOnly = () => {
    balancer.model('default');
    balancer.model('ocr');
    // @ts-expect-error: the pool was not configured
    balancer.model('ocrr');

    new LoadBalancer({
      providers: [alpha],
      // @ts-expect-error: no provider is named 'gamma'
      pools: { default: [{ provider: 'gamma', model: 'g' }] },
    });
  };
  void compileOnly;
});
