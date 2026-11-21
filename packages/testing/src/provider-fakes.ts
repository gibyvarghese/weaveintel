// SPDX-License-Identifier: MIT
/**
 * In-process fake model-provider servers, one per wire format.
 *
 * In plain terms: these are tiny web servers that run inside a test and answer
 * the way Groq, Azure, Databricks, AWS Bedrock, Google Gemini and Vertex AI
 * answer, as described in each vendor's public API documents. They let an
 * adapter be proved end to end (real HTTP, real streaming, real signatures)
 * without an account, a key or the internet.
 *
 * They are fakes, not emulators: replies are canned and deterministic. A test
 * can switch a server into a failure mode (rate limited, hanging, sending
 * garbage) to prove the caller reacts correctly.
 *
 * Built on `node:http` and `node:crypto` only.
 */

import { createHash, createHmac, createVerify } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

// ─── Shared ──────────────────────────────────────────────────

/** How the server answers. `ok` is normal service. */
export type FakeProviderMode = 'ok' | 'rate_limit' | 'server_error' | 'hang' | 'malformed';

export interface FakeProviderRequest {
  readonly method: string;
  /** Path without the query string, still percent-encoded as it arrived. */
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeProviderServer {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** Every request received, oldest first. */
  readonly requests: FakeProviderRequest[];
  /**
   * Answer the next `times` requests (default: all of them) in this mode, then
   * go back to normal service.
   */
  setMode(mode: FakeProviderMode, opts?: { times?: number; retryAfterSeconds?: number; retryAfterMs?: number }): void;
  /** Change the key the server accepts, as if the operator rotated it. */
  setKey(key: string): void;
  close(): Promise<void>;
}

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Pieces written one after another, for streaming replies. */
  chunks?: Array<string | Uint8Array>;
}

interface ServerState {
  mode: FakeProviderMode;
  remaining: number;
  retryAfterSeconds: number;
  retryAfterMs: number | undefined;
  key: string;
}

type Handler = (req: FakeProviderRequest, state: ServerState) => Reply | undefined;

interface FailureShapes {
  rateLimit(state: ServerState): Reply;
  serverError(): Reply;
}

async function startFake(initialKey: string, failures: FailureShapes, handler: Handler): Promise<FakeProviderServer> {
  const state: ServerState = { mode: 'ok', remaining: 0, retryAfterSeconds: 7, retryAfterMs: undefined, key: initialKey };
  const requests: FakeProviderRequest[] = [];
  const sockets = new Set<Socket>();

  const write = async (res: ServerResponse, reply: Reply): Promise<void> => {
    res.writeHead(reply.status, reply.headers ?? { 'content-type': 'application/json' });
    if (reply.chunks) {
      for (const chunk of reply.chunks) {
        res.write(chunk);
        await new Promise((r) => setTimeout(r, 1));
      }
      res.end();
      return;
    }
    res.end(reply.body ?? '');
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => {
      const rawUrl = req.url ?? '/';
      const q = rawUrl.indexOf('?');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
      const captured: FakeProviderRequest = {
        method: req.method ?? 'GET',
        path: q === -1 ? rawUrl : rawUrl.slice(0, q),
        query: q === -1 ? '' : rawUrl.slice(q + 1),
        headers,
        body: Buffer.concat(parts).toString('utf8'),
      };
      requests.push(captured);

      let mode: FakeProviderMode = 'ok';
      if (state.mode !== 'ok') {
        mode = state.mode;
        if (state.remaining > 0) {
          state.remaining -= 1;
          if (state.remaining === 0) state.mode = 'ok';
        }
      }
      if (mode === 'hang') return; // never answers; the socket is closed when the server is
      let reply: Reply;
      if (mode === 'rate_limit') reply = failures.rateLimit(state);
      else if (mode === 'server_error') reply = failures.serverError();
      else if (mode === 'malformed') reply = { status: 200, headers: { 'content-type': 'application/json' }, body: '<html><body>upstream proxy says hello' };
      else reply = handler(captured, state) ?? { status: 404, body: JSON.stringify({ error: { message: `No such route: ${captured.method} ${captured.path}` } }) };
      void write(res, reply).catch(() => undefined);
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    host: '127.0.0.1',
    port,
    requests,
    setMode(mode, opts) {
      state.mode = mode;
      state.remaining = opts?.times ?? 0;
      if (opts?.retryAfterSeconds !== undefined) state.retryAfterSeconds = opts.retryAfterSeconds;
      state.retryAfterMs = opts?.retryAfterMs;
    },
    setKey(key) {
      state.key = key;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

function parse(body: string): Record<string, unknown> {
  try {
    const v = JSON.parse(body) as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The canned tool arguments every fake returns when it is asked to call a tool. */
export const FAKE_TOOL_ARGUMENTS = '{"city":"Wellington"}';
/** Token counts every fake reports for a chat reply. */
export const FAKE_CHAT_USAGE = { promptTokens: 11, completionTokens: 7, totalTokens: 18 } as const;

/** The text every fake replies with for a given last user message. */
export function fakeReplyText(lastUserText: string): string {
  return `fake reply to: ${lastUserText}`;
}

/**
 * A deterministic vector for a text. Not unit length unless `normalize` is
 * true, so callers can prove they normalise.
 */
export function fakeVector(text: string, dimensions: number, normalize: boolean): number[] {
  let seed = 7;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) % 104729;
  const v: number[] = [];
  for (let i = 0; i < dimensions; i++) v.push(Math.sin(seed + i * 0.37) * 3 + 0.01);
  if (!normalize) return v;
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / length);
}

// ─── OpenAI-compatible (also Azure OpenAI, Azure AI Foundry, Databricks) ───

export interface FakeOpenAICompatibleOptions {
  /** The key the server accepts. */
  readonly apiKey: string;
  /** Which header carries it. `none` accepts every request. Default `bearer`. */
  readonly auth?: 'bearer' | 'api-key' | 'none';
  /** Size of vector returned when the request names none. Default 8. */
  readonly embeddingDimensions?: number;
  /** Whether vectors come back with unit length. Default false. */
  readonly normalize?: boolean;
  /**
   * Whether a rejected key is quoted back in the error, as some real servers
   * do. Default true, so callers can prove they scrub it.
   */
  readonly echoKeyInErrors?: boolean;
}

function lastUserTextOpenAI(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m['role'] !== 'user') continue;
    const c = m['content'];
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => String((p as Record<string, unknown>)['text'] ?? '')).join('');
  }
  return '';
}

function wantsToolCall(tools: unknown, messages: unknown, toolRole: (m: Record<string, unknown>) => boolean): boolean {
  if (!Array.isArray(tools) || tools.length === 0 || !Array.isArray(messages)) return false;
  const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
  return !(last && toolRole(last));
}

function sse(events: unknown[], done: boolean): Reply {
  const chunks = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
  if (done) chunks.push('data: [DONE]\n\n');
  return { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, chunks };
}

/**
 * A server that speaks the OpenAI chat-completions and embeddings format on
 * every path shape in use: `/chat/completions`, Azure's
 * `/openai/deployments/{name}/chat/completions`, Foundry's
 * `/models/chat/completions` and Databricks' `/serving-endpoints/{name}/invocations`.
 */
export function startFakeOpenAICompatibleServer(options: FakeOpenAICompatibleOptions): Promise<FakeProviderServer> {
  const auth = options.auth ?? 'bearer';
  const dims = options.embeddingDimensions ?? 8;
  const normalize = options.normalize ?? false;
  const echo = options.echoKeyInErrors ?? true;

  return startFake(
    options.apiKey,
    {
      rateLimit: (s) =>
        json(
          429,
          { error: { message: 'Rate limit reached for requests. Please try again later.', type: 'rate_limit_error', code: 'rate_limit_exceeded' } },
          { 'retry-after': String(s.retryAfterSeconds), ...(s.retryAfterMs !== undefined ? { 'retry-after-ms': String(s.retryAfterMs) } : {}) },
        ),
      serverError: () => json(500, { error: { message: 'The server had an error while processing your request.', type: 'server_error' } }),
    },
    (req, state) => {
      if (auth !== 'none') {
        const presented = auth === 'api-key' ? (req.headers['api-key'] ?? '') : (req.headers['authorization'] ?? '').replace(/^Bearer /, '');
        if (presented !== state.key) {
          return json(401, {
            error: { message: `Incorrect API key provided${echo && presented ? `: ${presented}` : ''}.`, type: 'invalid_request_error', code: 'invalid_api_key' },
          });
        }
      }
      const body = parse(req.body);

      if (req.method === 'GET') {
        if (req.path.endsWith('/serving-endpoints')) {
          return json(200, {
            endpoints: [
              { name: 'fake-chat', task: 'llm/v1/chat', state: { ready: 'READY' } },
              { name: 'fake-embed', task: 'llm/v1/embeddings', state: { ready: 'READY' } },
            ],
          });
        }
        if (req.path.endsWith('/info')) return json(200, { model_name: 'fake-chat', model_type: 'chat-completion', model_provider_name: 'Fake' });
        if (req.path.endsWith('/models')) {
          return json(200, { object: 'list', data: [{ id: 'fake-chat', object: 'model', owned_by: 'fake' }, { id: 'fake-embed', object: 'model', owned_by: 'fake' }] });
        }
        return undefined;
      }

      const isInvocation = req.path.endsWith('/invocations');
      const isChat = req.path.endsWith('/chat/completions') || (isInvocation && Array.isArray(body['messages']));
      const isEmbed = req.path.endsWith('/embeddings') || (isInvocation && body['input'] !== undefined);

      if (isChat) {
        const model = typeof body['model'] === 'string' ? body['model'] : 'fake-chat';
        const usage = { prompt_tokens: FAKE_CHAT_USAGE.promptTokens, completion_tokens: FAKE_CHAT_USAGE.completionTokens, total_tokens: FAKE_CHAT_USAGE.totalTokens };
        const tool = wantsToolCall(body['tools'], body['messages'], (m) => m['role'] === 'tool');
        const toolName = tool ? String((((body['tools'] as unknown[])[0] as Record<string, unknown>)['function'] as Record<string, unknown>)['name']) : '';
        const text = fakeReplyText(lastUserTextOpenAI(body['messages']));
        if (body['stream'] === true) {
          const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model };
          const events: unknown[] = [];
          if (tool) {
            const half = Math.ceil(FAKE_TOOL_ARGUMENTS.length / 2);
            events.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: toolName, arguments: '' } }] } }] });
            events.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: FAKE_TOOL_ARGUMENTS.slice(0, half) } }] } }] });
            events.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: FAKE_TOOL_ARGUMENTS.slice(half) } }] } }] });
            events.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
          } else {
            const half = Math.ceil(text.length / 2);
            events.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, half) } }] });
            events.push({ ...base, choices: [{ index: 0, delta: { content: text.slice(half) } }] });
            events.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          }
          const includeUsage = (body['stream_options'] as Record<string, unknown> | undefined)?.['include_usage'] === true;
          if (includeUsage) events.push({ ...base, choices: [], usage });
          return sse(events, true);
        }
        return json(200, {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model,
          choices: [
            tool
              ? { index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_fake_1', type: 'function', function: { name: toolName, arguments: FAKE_TOOL_ARGUMENTS } }] }, finish_reason: 'tool_calls' }
              : { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage,
        });
      }

      if (isEmbed) {
        const input = Array.isArray(body['input']) ? (body['input'] as unknown[]).map(String) : [String(body['input'] ?? '')];
        const size = Number(body['dimensions'] ?? body['output_dimension'] ?? dims);
        return json(200, {
          object: 'list',
          model: typeof body['model'] === 'string' ? body['model'] : 'fake-embed',
          data: input.map((text, index) => ({ object: 'embedding', index, embedding: fakeVector(text, size, normalize) })),
          usage: { prompt_tokens: input.length * 3, total_tokens: input.length * 3 },
        });
      }
      return undefined;
    },
  );
}

// ─── AWS Bedrock ─────────────────────────────────────────────

export interface FakeBedrockOptions {
  /** A Bedrock API key the server accepts as a bearer token. */
  readonly apiKey?: string;
  /** An access key pair the server accepts as a SigV4 signature. */
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  /** When set, a signed request must also carry this session token. */
  readonly sessionToken?: string;
  /** The region signatures must be scoped to. Default `us-east-1`. */
  readonly region?: string;
  readonly normalize?: boolean;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Frame one AWS event-stream message (string headers only). */
export function fakeEventStreamMessage(headers: Readonly<Record<string, string>>, payload: string): Uint8Array {
  const headerBytes: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    headerBytes.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v);
  }
  const body = Buffer.from(payload, 'utf8');
  const total = 12 + headerBytes.length + body.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headerBytes.length, 4);
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  Buffer.from(headerBytes).copy(out, 12);
  body.copy(out, 12 + headerBytes.length);
  out.writeUInt32BE(crc32(out.subarray(0, total - 4)), total - 4);
  return new Uint8Array(out);
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Recompute an AWS Signature Version 4 from the request as it arrived and say
 * whether it matches. Written separately from the signer it checks.
 */
function verifySigV4(req: FakeProviderRequest, secretAccessKey: string, expectedRegion: string): { ok: boolean; accessKeyId: string; reason?: string } {
  const header = req.headers['authorization'] ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(header);
  if (!m) return { ok: false, accessKeyId: '', reason: 'not a SigV4 authorization header' };
  const [, accessKeyId = '', date = '', region = '', service = '', signedHeaders = '', signature = ''] = m;
  if (region !== expectedRegion) return { ok: false, accessKeyId, reason: 'wrong region in the credential scope' };
  if (service !== 'bedrock') return { ok: false, accessKeyId, reason: 'wrong service in the credential scope' };
  const names = signedHeaders.split(';');
  for (const required of ['host', 'x-amz-date']) if (!names.includes(required)) return { ok: false, accessKeyId, reason: `${required} is not signed` };
  if (req.headers['x-amz-security-token'] !== undefined && !names.includes('x-amz-security-token')) return { ok: false, accessKeyId, reason: 'the session token is not signed' };
  const amzDate = req.headers['x-amz-date'] ?? '';
  if (!amzDate.startsWith(date)) return { ok: false, accessKeyId, reason: 'the date does not match the scope' };
  const canonicalUri = req.path.split('/').map((s) => awsEncode(s)).join('/');
  const canonicalQuery = req.query === '' ? '' : req.query.split('&').map((p) => { const i = p.indexOf('='); return i === -1 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; }).map(([k, v]) => `${awsEncode(decodeURIComponent(k ?? ''))}=${awsEncode(decodeURIComponent(v ?? ''))}`).sort().join('&');
  const canonicalHeaders = names.map((n) => `${n}:${(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const hash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
  const canonical = [req.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, hash(req.body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
  const h = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();
  const expected = h(h(h(h(h(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request'), toSign).toString('hex');
  return expected === signature ? { ok: true, accessKeyId } : { ok: false, accessKeyId, reason: 'signature mismatch' };
}

function lastUserTextConverse(messages: unknown): { text: string; lastIsToolResult: boolean } {
  let text = '';
  let lastIsToolResult = false;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as Record<string, unknown>;
      const blocks = Array.isArray(m['content']) ? (m['content'] as Array<Record<string, unknown>>) : [];
      if (i === messages.length - 1) lastIsToolResult = blocks.some((b) => b['toolResult'] !== undefined);
      if (m['role'] !== 'user') continue;
      const t = blocks.map((b) => (typeof b['text'] === 'string' ? b['text'] : '')).join('');
      if (t !== '') {
        text = t;
        break;
      }
    }
  }
  return { text, lastIsToolResult };
}

/** A server that speaks Bedrock's Converse, ConverseStream, InvokeModel (embeddings) and ListFoundationModels. */
export function startFakeBedrockServer(options: FakeBedrockOptions): Promise<FakeProviderServer> {
  const region = options.region ?? 'us-east-1';
  const normalize = options.normalize ?? false;
  const denied = (type: string, message: string): Reply => json(403, { message }, { 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.coral.service/` });

  return startFake(
    options.apiKey ?? options.secretAccessKey ?? '',
    {
      rateLimit: (s) => json(429, { message: 'Too many requests, please wait before trying again.' }, { 'x-amzn-errortype': 'ThrottlingException', 'retry-after': String(s.retryAfterSeconds) }),
      serverError: () => json(500, { message: 'The service encountered an internal error.' }, { 'x-amzn-errortype': 'InternalServerException' }),
    },
    (req, state) => {
      const authorization = req.headers['authorization'] ?? '';
      if (authorization.startsWith('Bearer ')) {
        if (options.apiKey === undefined || authorization.slice(7) !== state.key) return denied('UnrecognizedClientException', 'The security token included in the request is invalid.');
      } else if (authorization.startsWith('AWS4-HMAC-SHA256')) {
        if (options.secretAccessKey === undefined) return denied('UnrecognizedClientException', 'The security token included in the request is invalid.');
        const result = verifySigV4(req, options.apiKey === undefined ? state.key : options.secretAccessKey, region);
        if (result.accessKeyId !== options.accessKeyId) return denied('UnrecognizedClientException', 'The security token included in the request is invalid.');
        if (!result.ok) return denied('InvalidSignatureException', `The request signature we calculated does not match the signature you provided (${result.reason ?? ''}).`);
        if (options.sessionToken !== undefined && req.headers['x-amz-security-token'] !== options.sessionToken) return denied('ExpiredTokenException', 'The security token included in the request is expired.');
      } else {
        return denied('MissingAuthenticationTokenException', 'Missing Authentication Token');
      }

      if (req.method === 'GET' && req.path === '/foundation-models') {
        return json(200, {
          modelSummaries: [
            { modelId: 'fake.chat-v1:0', modelName: 'Chat', providerName: 'Fake', inputModalities: ['TEXT'], outputModalities: ['TEXT'], responseStreamingSupported: true, modelLifecycle: { status: 'ACTIVE' } },
            { modelId: 'amazon.titan-embed-text-v2:0', modelName: 'Titan Text Embeddings V2', providerName: 'Amazon', inputModalities: ['TEXT'], outputModalities: ['EMBEDDING'], modelLifecycle: { status: 'ACTIVE' } },
            { modelId: 'cohere.embed-english-v3', modelName: 'Embed English', providerName: 'Cohere', inputModalities: ['TEXT'], outputModalities: ['EMBEDDING'], modelLifecycle: { status: 'ACTIVE' } },
          ],
        });
      }

      const route = /^\/model\/([^/]+)\/(converse|converse-stream|invoke)$/.exec(req.path);
      if (req.method !== 'POST' || !route) return undefined;
      const modelId = decodeURIComponent(route[1] ?? '');
      const action = route[2];
      const body = parse(req.body);

      if (action === 'invoke') {
        if (/titan-embed/.test(modelId)) {
          const text = String(body['inputText'] ?? '');
          const size = Number(body['dimensions'] ?? 1024);
          return json(200, { embedding: fakeVector(text, size, body['normalize'] !== false && normalize), inputTextTokenCount: 3 }, { 'x-amzn-bedrock-input-token-count': '3' });
        }
        if (/cohere\.embed/.test(modelId)) {
          const texts = Array.isArray(body['texts']) ? (body['texts'] as unknown[]).map(String) : [];
          const size = Number(body['output_dimension'] ?? 1024);
          const vectors = texts.map((t) => fakeVector(t, size, normalize));
          const typed = Array.isArray(body['embedding_types']);
          return json(
            200,
            { id: 'fake', response_type: typed ? 'embeddings_by_type' : 'embeddings_floats', embeddings: typed ? { float: vectors } : vectors, texts },
            { 'x-amzn-bedrock-input-token-count': String(texts.length * 3) },
          );
        }
        return json(400, { message: `The provided model identifier is invalid: ${modelId}` }, { 'x-amzn-errortype': 'ValidationException' });
      }

      const toolConfig = body['toolConfig'] as Record<string, unknown> | undefined;
      const tools = Array.isArray(toolConfig?.['tools']) ? (toolConfig['tools'] as Array<Record<string, unknown>>) : [];
      const { text: userText, lastIsToolResult } = lastUserTextConverse(body['messages']);
      const tool = tools.length > 0 && !lastIsToolResult;
      const toolName = tool ? String((tools[0]?.['toolSpec'] as Record<string, unknown> | undefined)?.['name'] ?? '') : '';
      const text = fakeReplyText(userText);
      const usage = { inputTokens: FAKE_CHAT_USAGE.promptTokens, outputTokens: FAKE_CHAT_USAGE.completionTokens, totalTokens: FAKE_CHAT_USAGE.totalTokens };

      if (action === 'converse') {
        return json(
          200,
          {
            output: { message: { role: 'assistant', content: tool ? [{ toolUse: { toolUseId: 'tooluse_fake_1', name: toolName, input: JSON.parse(FAKE_TOOL_ARGUMENTS) as unknown } }] : [{ text }] } },
            stopReason: tool ? 'tool_use' : 'end_turn',
            usage,
            metrics: { latencyMs: 12 },
          },
          { 'x-amzn-requestid': 'fake-request-1' },
        );
      }

      const event = (type: string, payload: unknown): Uint8Array =>
        fakeEventStreamMessage({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, JSON.stringify(payload));
      const frames: Uint8Array[] = [event('messageStart', { role: 'assistant' })];
      if (tool) {
        const half = Math.ceil(FAKE_TOOL_ARGUMENTS.length / 2);
        frames.push(event('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tooluse_fake_1', name: toolName } } }));
        frames.push(event('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: FAKE_TOOL_ARGUMENTS.slice(0, half) } } }));
        frames.push(event('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: FAKE_TOOL_ARGUMENTS.slice(half) } } }));
      } else {
        const half = Math.ceil(text.length / 2);
        frames.push(event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: text.slice(0, half) } }));
        frames.push(event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: text.slice(half) } }));
      }
      frames.push(event('contentBlockStop', { contentBlockIndex: 0 }));
      frames.push(event('messageStop', { stopReason: tool ? 'tool_use' : 'end_turn' }));
      frames.push(event('metadata', { usage, metrics: { latencyMs: 12 } }));
      // Split one frame across two writes so a reader must reassemble it.
      const joined = Buffer.concat(frames.map((f) => Buffer.from(f)));
      const cut = Math.floor(joined.length / 2) + 3;
      return { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' }, chunks: [new Uint8Array(joined.subarray(0, cut)), new Uint8Array(joined.subarray(cut))] };
    },
  );
}

// ─── Google: Gemini API and Vertex AI ────────────────────────

export interface FakeGoogleOptions {
  /** Gemini API key accepted in `x-goog-api-key`. */
  readonly apiKey?: string;
  /**
   * Vertex AI: the service account whose signed assertions the token endpoint
   * (`/token` on this server) accepts.
   */
  readonly serviceAccount?: { readonly clientEmail: string; readonly publicKeyPem: string };
  readonly normalize?: boolean;
}

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** A server that speaks the Gemini API and Vertex AI REST formats, plus Google's OAuth token endpoint. */
export function startFakeGoogleServer(options: FakeGoogleOptions): Promise<FakeProviderServer & { /** Access tokens the token endpoint has issued, oldest first. */ readonly issuedTokens: string[] }> {
  const normalize = options.normalize ?? false;
  const issuedTokens: string[] = [];
  const googleError = (code: number, status: string, message: string, details?: unknown[]): Reply => json(code, { error: { code, message, status, ...(details ? { details } : {}) } });

  return startFake(
    options.apiKey ?? '',
    {
      rateLimit: (s) => ({ ...googleError(429, 'RESOURCE_EXHAUSTED', 'Resource exhausted, please try again later.'), headers: { 'content-type': 'application/json', 'retry-after': String(s.retryAfterSeconds) } }),
      serverError: () => googleError(500, 'INTERNAL', 'An internal error has occurred.'),
    },
    (req, state) => {
      // The OAuth token endpoint: a signed assertion in, an access token out.
      if (req.method === 'POST' && req.path === '/token') {
        const form = new URLSearchParams(req.body);
        const assertion = form.get('assertion') ?? '';
        const [h = '', p = '', s = ''] = assertion.split('.');
        const sa = options.serviceAccount;
        let ok = form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && sa !== undefined && h !== '' && p !== '' && s !== '';
        if (ok && sa) {
          try {
            const header = JSON.parse(base64UrlDecode(h).toString('utf8')) as Record<string, unknown>;
            const claims = JSON.parse(base64UrlDecode(p).toString('utf8')) as Record<string, unknown>;
            const now = Math.floor(Date.now() / 1000);
            ok =
              header['alg'] === 'RS256' &&
              claims['iss'] === sa.clientEmail &&
              claims['scope'] === 'https://www.googleapis.com/auth/cloud-platform' &&
              typeof claims['aud'] === 'string' &&
              claims['aud'].endsWith('/token') &&
              typeof claims['exp'] === 'number' &&
              claims['exp'] > now &&
              claims['exp'] <= now + 3600 + 60 &&
              createVerify('RSA-SHA256').update(`${h}.${p}`).verify(sa.publicKeyPem, base64UrlDecode(s));
          } catch {
            ok = false;
          }
        }
        if (!ok) return json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
        const token = `fake-access-token-${issuedTokens.length + 1}-${createHash('sha256').update(assertion).digest('hex').slice(0, 12)}`;
        issuedTokens.push(token);
        return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
      }

      const vertex = req.path.startsWith('/v1/projects/') || req.path.startsWith('/v1beta1/publishers/');
      if (vertex) {
        const presented = (req.headers['authorization'] ?? '').replace(/^Bearer /, '');
        if (presented === '' || !issuedTokens.includes(presented)) {
          return googleError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.');
        }
      } else {
        const presented = req.headers['x-goog-api-key'] ?? '';
        if (options.apiKey === undefined || presented !== state.key) {
          return googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }]);
        }
      }

      if (req.method === 'GET') {
        if (req.path === '/v1beta/models') {
          return json(200, {
            models: [
              { name: 'models/fake-chat', displayName: 'Fake Chat', inputTokenLimit: 1000000, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent', 'countTokens'] },
              { name: 'models/gemini-embedding-001', displayName: 'Gemini Embedding 001', inputTokenLimit: 2048, supportedGenerationMethods: ['embedContent', 'batchEmbedContents'] },
            ],
          });
        }
        if (req.path === '/v1beta1/publishers/google/models') {
          return json(200, {
            publisherModels: [
              { name: 'publishers/google/models/fake-chat', versionId: '001', launchStage: 'GA' },
              { name: 'publishers/google/models/text-embedding-005', versionId: '005', launchStage: 'GA' },
            ],
          });
        }
        return undefined;
      }

      const route = /\/models\/([^/:]+):(generateContent|streamGenerateContent|embedContent|batchEmbedContents|predict)$/.exec(req.path);
      if (req.method !== 'POST' || !route) return undefined;
      const action = route[2];
      const body = parse(req.body);

      const textOf = (content: unknown): string => {
        const parts = (content as Record<string, unknown> | undefined)?.['parts'];
        return Array.isArray(parts) ? parts.map((x) => String((x as Record<string, unknown>)['text'] ?? '')).join('') : '';
      };
      const sizeOf = (r: Record<string, unknown>): number => {
        const cfg = r['embedContentConfig'] as Record<string, unknown> | undefined;
        return Number(cfg?.['outputDimensionality'] ?? r['outputDimensionality'] ?? 3072);
      };

      if (action === 'embedContent') {
        return json(200, { embedding: { values: fakeVector(textOf(body['content']), sizeOf(body), normalize) }, usageMetadata: { promptTokenCount: 3 } });
      }
      if (action === 'batchEmbedContents') {
        const reqs = Array.isArray(body['requests']) ? (body['requests'] as Array<Record<string, unknown>>) : [];
        return json(200, { embeddings: reqs.map((r) => ({ values: fakeVector(textOf(r['content']), sizeOf(r), normalize) })), usageMetadata: { promptTokenCount: reqs.length * 3 } });
      }
      if (action === 'predict') {
        const instances = Array.isArray(body['instances']) ? (body['instances'] as Array<Record<string, unknown>>) : [];
        const size = Number((body['parameters'] as Record<string, unknown> | undefined)?.['outputDimensionality'] ?? 768);
        return json(200, {
          predictions: instances.map((i) => ({ embeddings: { values: fakeVector(String(i['content'] ?? ''), size, normalize), statistics: { token_count: 3, truncated: false } } })),
        });
      }

      const contents = Array.isArray(body['contents']) ? (body['contents'] as Array<Record<string, unknown>>) : [];
      const last = contents[contents.length - 1];
      const lastParts = Array.isArray(last?.['parts']) ? (last['parts'] as Array<Record<string, unknown>>) : [];
      const lastIsToolResult = lastParts.some((x) => x['functionResponse'] !== undefined);
      let userText = '';
      for (let i = contents.length - 1; i >= 0; i--) {
        if (contents[i]?.['role'] !== 'user') continue;
        const t = textOf(contents[i]);
        if (t !== '') {
          userText = t;
          break;
        }
      }
      const declared = Array.isArray(body['tools']) ? (body['tools'] as Array<Record<string, unknown>>).flatMap((t) => (Array.isArray(t['functionDeclarations']) ? (t['functionDeclarations'] as Array<Record<string, unknown>>) : [])) : [];
      const tool = declared.length > 0 && !lastIsToolResult;
      const text = fakeReplyText(userText);
      const usageMetadata = { promptTokenCount: FAKE_CHAT_USAGE.promptTokens, candidatesTokenCount: FAKE_CHAT_USAGE.completionTokens, totalTokenCount: FAKE_CHAT_USAGE.totalTokens };
      const candidate = (parts: unknown[], finish?: string): unknown => ({ candidates: [{ content: { role: 'model', parts }, ...(finish ? { finishReason: finish } : {}), index: 0 }] });

      if (action === 'streamGenerateContent') {
        if (tool) {
          return sse([{ ...(candidate([{ functionCall: { name: String(declared[0]?.['name'] ?? ''), args: JSON.parse(FAKE_TOOL_ARGUMENTS) as unknown } }], 'STOP') as object), usageMetadata }], false);
        }
        const half = Math.ceil(text.length / 2);
        return sse([candidate([{ text: text.slice(0, half) }]), { ...(candidate([{ text: text.slice(half) }], 'STOP') as object), usageMetadata }], false);
      }
      return json(200, {
        ...(candidate(tool ? [{ functionCall: { name: String(declared[0]?.['name'] ?? ''), args: JSON.parse(FAKE_TOOL_ARGUMENTS) as unknown } }] : [{ text }], 'STOP') as object),
        usageMetadata,
        modelVersion: 'fake-chat',
      });
    },
  ).then((server) => Object.assign(server, { issuedTokens }));
}
