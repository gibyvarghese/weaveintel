export {
  weaveFakeModel,
  weaveFakeEmbedding,
  weaveFakeVectorStore,
  weaveFakeTransport,
  weaveFakeContainerRuntime,
  FakeRuntime,
  type FakeModelOptions,
  type FakeRuntimeOptions,
  type ContainerRuntime,
  type ContainerRunResult,
} from './fakes.js';

// Real MCP transport (optional, for HTTP-based MCP servers)
export {
  weaveRealMCPTransport,
  type RealMCPTransportOptions,
  type RealMCPTransportServer,
} from './mcp-transport.js';
