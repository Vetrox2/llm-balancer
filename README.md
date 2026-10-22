<div align="center">

# ⚖️ llm-balancer

**One call, many models. When one fails, the next one answers.**

[![JSR](https://jsr.io/badges/@vetrox/llm-balancer)](https://jsr.io/@vetrox/llm-balancer)
[![CI](https://github.com/Vetrox2/llm-balancer/actions/workflows/ci.yml/badge.svg)](https://github.com/Vetrox2/llm-balancer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

### [📖 Documentation](https://vetrox2.github.io/llm-balancer/)

</div>

---

## Why

LLM APIs fail all the time: quotas run out, models get overloaded, requests hang. `llm-balancer`
keeps that out of your application code.

|                        |                                                                       |
| ---------------------- | --------------------------------------------------------------------- |
| 🔁 **Fallback**        | Group models into pools. A failed model hands the request to the next |
| 🩺 **Model health**    | A failing model sits out a cooldown instead of failing every request  |
| ⏱️ **Time budgets**    | A timeout per attempt and a limit for the whole request               |
| 🔌 **Any vendor**      | Gemini, Ollama, OpenRouter and any OpenAI-compatible API built in     |
| 🧷 **Type-safe pools** | `balancer.model('typo')` does not compile                             |
| 📡 **Observable**      | One event hook for logs, and it never sees prompts or answers         |

## How it works

```
balancer.model('default').converse(request)
        │
        ├─▶ gemini-2.5-flash       ✗ 503 overloaded  → 60 s cooldown
        ├─▶ gemini-2.5-flash-lite  ✓ answer
        └─▶ ollama / qwen3         (not needed)
```

The next request skips the model that is cooling down and goes straight to one that works.

## Install

```sh
deno add jsr:@vetrox/llm-balancer      # Deno
npx jsr add @vetrox/llm-balancer       # Node.js
bunx jsr add @vetrox/llm-balancer      # Bun
```

Runs on Deno, Node.js, Bun and edge runtimes (Supabase Edge Functions, Cloudflare Workers). The core
uses web-standard APIs only.

## Set it up

Create **one** balancer when your app starts and share it, because it holds the health of every
model.

```ts
import { LoadBalancer } from '@vetrox/llm-balancer';
import { gemini } from '@vetrox/llm-balancer/gemini';

export const balancer = new LoadBalancer({
  providers: [gemini({ apiKey: GEMINI_API_KEY })],
  pools: {
    default: [
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
    ],
  },
});
```

Then ask a pool for an answer:

```ts
const answer = await balancer.model('default').converse({
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

That is all you need to start. Out of the box the balancer uses sensible defaults: a 60 s cooldown,
a 25 s timeout per attempt and a 60 s budget per request.

## Go further

The [documentation](https://vetrox2.github.io/llm-balancer/) covers everything else:

- 🎛️ [Configuration](https://vetrox2.github.io/llm-balancer/#configuration): cooldowns per failure
  kind, last-resort retries, timeouts
- 🚨 [Errors](https://vetrox2.github.io/llm-balancer/#errors): what is thrown and when
- 📡 [Events](https://vetrox2.github.io/llm-balancer/#events): wiring the balancer to your logger
- 🔌 [Providers](https://vetrox2.github.io/llm-balancer/#providers): Gemini, Ollama, OpenRouter,
  OpenAI-compatible APIs, environment variables, and writing your own
- 🗄️ [Health store](https://vetrox2.github.io/llm-balancer/#health-store): sharing cooldowns between
  instances
- 🧪 [Testing](https://vetrox2.github.io/llm-balancer/#testing): faking the balancer in your tests

## License

[MIT](LICENSE)
