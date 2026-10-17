export type { TokenSipFetchOptions } from "./fetch.js";
export { createTokenSipFetch } from "./fetch.js";
export {
  canonicalJson,
  minifyJsonText,
  requestFingerprint,
  sha256,
} from "./json.js";
export type {
  ProfileInfo,
  Stage,
  StageContext,
  StageResult,
} from "./optimizers/index.js";
export {
  compactProse,
  headTail,
  normalizeProse,
  PROFILE_INFO,
  PROFILES,
  STAGE_BY_ID,
  STAGES,
} from "./optimizers/index.js";
export { DEFAULT_STAGE_OPTIONS, optimize, resolveStages } from "./pipeline.js";
export { computeCost, DEFAULT_PRICES, PriceBook } from "./pricing.js";
export type {
  MessageInfo,
  ProtocolAdapter,
  TextSlot,
} from "./protocols/index.js";
export { adapterFor, protocolFromPath } from "./protocols/index.js";
export {
  matchProviderByModel,
  PROVIDER_BY_ID,
  PROVIDERS,
  surfaceForProtocol,
} from "./providers.js";
export type { Block } from "./session/blocks.js";
export { blocksOf, commonPrefix } from "./session/blocks.js";
export type { SessionEngineOptions, SessionReport } from "./session/engine.js";
export { SessionEngine } from "./session/engine.js";
export type { CacheLeak, LeakKind } from "./session/leaks.js";
export { classify, detectLeak, maskShape, volatileSpan } from "./session/leaks.js";
export type { Resource } from "./session/resources.js";
export { resourceOf } from "./session/resources.js";
export type { SchedulerDecision, SessionRuntime, SessionState } from "./session/runtime.js";
export { observations, supersededMap } from "./session/supersede.js";
export type { SimulationResult, Strategy } from "./simulate.js";
export { STRATEGIES, simulate } from "./simulate.js";
export type { SseEvent } from "./sse.js";
export { SseParser } from "./sse.js";
export { countTokens, countValueTokens } from "./tokenizer.js";
export type * from "./types.js";
export {
  emptyUsage,
  StreamUsageAccumulator,
  usageFromResponse,
} from "./usage.js";

export const VERSION = "2.0.0";
