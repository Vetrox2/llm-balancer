/**
 * Load balancer for LLM providers: named pools of models with automatic fallback, per-model
 * cooldowns and time budgets.
 *
 * Built-in providers live in their own entry points (`@vetrox/llm-balancer/gemini`,
 * `@vetrox/llm-balancer/ollama`), so the core has no vendor dependencies.
 *
 * @module
 */
export {
  type ILoadBalancer,
  LoadBalancer,
  type LoadBalancerConfig,
  type ModelStatus,
  type TimeoutConfig,
} from './src/balancer.ts';
export type { IModelHandle } from './src/model-handle.ts';
export {
  AllModelsFailedError,
  type AttemptFailure,
  BalancerConfigError,
  type FailureKind,
  LlmContentBlockedError,
  LlmProviderError,
  type LlmProviderErrorOptions,
} from './src/errors.ts';
export type { BalancerEvent, BalancerEventListener } from './src/events.ts';
export { type HealthRecord, type IHealthStore, MemoryHealthStore } from './src/health/store.ts';
export type { FailurePolicy, HealthPolicyConfig } from './src/policy.ts';
export { failureKindForStatus } from './src/http-status.ts';
export type {
  ConverseRequest,
  ILlmProvider,
  ImagePart,
  Message,
  ModelRef,
  ModelRefOf,
  Part,
  Role,
  TextPart,
} from './src/types.ts';
