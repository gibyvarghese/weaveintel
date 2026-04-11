/**
 * @weaveintel/tools-http — HTTP endpoint tooling with auth, retry, rate limiting
 */
export type { HttpEndpointConfig, HttpRequestOptions, HttpResponse } from './types.js';
export { httpRequest, executeEndpoint } from './client.js';
export { createHttpTools } from './mcp.js';

// Convenience aliases
export { httpRequest as weaveHttpRequest } from './client.js';
export { executeEndpoint as weaveHttpEndpoint } from './client.js';
export { createHttpTools as weaveHttpTools } from './mcp.js';
