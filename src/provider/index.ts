export { MockLLMProvider } from './mock-llm.js';
export { HashEmbedder } from './interfaces.js';
export { OllamaEmbedder, FallbackEmbedder } from './ollama-embedder.js';
export { OpenAIEmbedder } from './openai-embedder.js';
export { OpenAICompatLLM, loadLLMConfig, loadLLMConfigSync, buildLLM } from './openai-llm.js';
export type { LLMConfig } from './openai-llm.js';
export type {
  Embedder,
  LLMProvider,
  ExtractionResult,
  ExtractedEntity,
  ExtractedFact,
  ExtractedInvalidation,
  ExtractOptions,
  KnownEntity,
  KnownFact,
  ContradictionCandidate,
  ContradictionExisting,
} from './interfaces.js';
export type { FallbackEmbedderOptions } from './ollama-embedder.js';
