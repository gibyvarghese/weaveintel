/**
 * @weaveintel/provider-ollama — Local LLMs via Ollama for weaveIntel.
 *
 * Auto-registers the `ollama` provider on import. Default base URL is
 * `http://localhost:11434`; override via `OLLAMA_BASE_URL` or per-instance.
 */

export {
  weaveOllamaModel,
  weaveOllamaEmbeddingModel,
  weaveOllamaConfig,
  weaveOllama,
  weaveOllamaEmbedding,
  type OllamaProviderOptions,
} from './ollama.js';
