/**
 * @weaveintel/provider-llamacpp — Local GGUF models via the llama.cpp HTTP server.
 *
 * Auto-registers the `llamacpp` provider on import. Default base URL is
 * `http://localhost:8080`; override via `LLAMACPP_BASE_URL` or per-instance.
 */

export {
  weaveLlamaCppModel,
  weaveLlamaCppEmbeddingModel,
  weaveLlamaCppConfig,
  weaveLlamaCpp,
  weaveLlamaCppEmbedding,
  type LlamaCppProviderOptions,
} from './llamacpp.js';
