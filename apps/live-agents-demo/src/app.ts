import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  createActionExecutor,
  type Account,
  type AccountBinding,
  createHeartbeat,
  type AgentContract,
  type AttentionPolicy,
  type Heartbeat,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
  type Message,
  type StateStore,
} from '@weaveintel/live-agents';
import { weaveContext, type Model, type ExecutionContext, type ModelRequest, type ModelResponse } from '@weaveintel/core';

export interface LiveAgentsDemoConfig {
  stateStore: StateStore;
  host?: string;
  port?: number;
}

export interface LiveAgentsDemoApp {
  server: Server;
  stateStore: StateStore;
  stop(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function badRequest(res: ServerResponse, error: string): void {
  json(res, 400, { error });
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: 'Not found' });
}

function htmlUI(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Live Agents Demo</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f5f5;
      color: #333;
    }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    header { 
      background: #2c3e50;
      color: white;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 30px;
    }
    h1 { font-size: 24px; margin-bottom: 5px; }
    .subtitle { font-size: 14px; opacity: 0.9; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
    .panel {
      background: white;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .panel h2 { font-size: 16px; margin-bottom: 15px; color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 8px; }
    input, textarea { 
      width: 100%;
      padding: 8px;
      margin: 8px 0;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
    }
    button {
      background: #3498db;
      color: white;
      border: none;
      padding: 10px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      margin-top: 10px;
      width: 100%;
    }
    button:hover { background: #2980b9; }
    button:active { background: #1f618d; }
    .success { color: #27ae60; font-size: 12px; margin-top: 10px; }
    .error { color: #e74c3c; font-size: 12px; margin-top: 10px; }
    .output { 
      background: #f8f8f8;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 10px;
      margin-top: 10px;
      font-size: 11px;
      max-height: 200px;
      overflow-y: auto;
      font-family: monospace;
      white-space: pre-wrap;
    }
    .inbox { margin-top: 20px; }
    .message-item {
      background: #ecf0f1;
      border-left: 4px solid #3498db;
      padding: 10px;
      margin: 8px 0;
      border-radius: 4px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🤖 Live Agents Demo</h1>
      <p class="subtitle">Test the @weaveintel/live-agents API</p>
    </header>

    <div class="grid">
      <div class="panel">
        <h2>Create Mesh</h2>
        <input type="text" id="meshId" placeholder="Mesh ID" value="mesh-ui-1">
        <input type="text" id="meshName" placeholder="Name" value="Demo Mesh">
        <input type="text" id="meshCharter" placeholder="Charter" value="UI test mesh">
        <button onclick="createMesh()">Create Mesh</button>
        <div id="meshOutput"></div>
      </div>

      <div class="panel">
        <h2>Create Agent</h2>
        <input type="text" id="agentId" placeholder="Agent ID" value="agent-ui-1">
        <input type="text" id="agentMeshId" placeholder="Mesh ID" value="mesh-ui-1">
        <input type="text" id="agentName" placeholder="Name" value="Demo Agent">
        <input type="text" id="agentRole" placeholder="Role" value="Coordinator">
        <button onclick="createAgent()">Create Agent</button>
        <div id="agentOutput"></div>
      </div>

      <div class="panel">
        <h2>Create Contract</h2>
        <input type="text" id="contractId" placeholder="Contract ID" value="contract-ui-1">
        <input type="text" id="contractAgentId" placeholder="Agent ID" value="agent-ui-1">
        <button onclick="createContract()">Create Contract</button>
        <div id="contractOutput"></div>
      </div>

      <div class="panel">
        <h2>Send Message</h2>
        <input type="text" id="messageId" placeholder="Message ID" value="msg-ui-1">
        <input type="text" id="messageMeshId" placeholder="Mesh ID" value="mesh-ui-1">
        <input type="text" id="messageToAgent" placeholder="To Agent ID" value="agent-ui-1">
        <input type="text" id="messageSubject" placeholder="Subject" value="Test message">
        <textarea id="messageBody" placeholder="Message body" rows="3">Please process this message.</textarea>
        <button onclick="sendMessage()">Send Message</button>
        <div id="messageOutput"></div>
      </div>

      <div class="panel">
        <h2>Schedule Tick</h2>
        <input type="text" id="tickId" placeholder="Tick ID" value="tick-ui-1">
        <input type="text" id="tickAgentId" placeholder="Agent ID" value="agent-ui-1">
        <button onclick="scheduleTick()">Schedule Tick</button>
        <div id="tickOutput"></div>
      </div>

      <div class="panel">
        <h2>Process Heartbeat</h2>
        <button onclick="runHeartbeat()">Run Heartbeat Once</button>
        <div id="heartbeatOutput"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Inbox</h2>
      <input type="text" id="inboxAgentId" placeholder="Agent ID" value="agent-ui-1">
      <button onclick="getInbox()">Fetch Inbox</button>
      <div id="inboxOutput" class="inbox"></div>
    </div>
  </div>

  <script>
    const API = 'http://localhost:3600/api';
    const now = new Date().toISOString();

    function output(elementId, text, isError = false) {
      const el = document.getElementById(elementId);
      el.innerHTML = \`<div class="\${isError ? 'error' : 'success'}">\${text}</div>\`;
    }

    async function createMesh() {
      const meshId = document.getElementById('meshId').value;
      try {
        const res = await fetch(\`\${API}/meshes\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: meshId,
            tenantId: 'tenant-ui',
            name: document.getElementById('meshName').value,
            charter: document.getElementById('meshCharter').value,
            status: 'ACTIVE',
            dualControlRequiredFor: ['MESH_BRIDGE'],
            createdAt: now,
          }),
        });
        const data = await res.json();
        output('meshOutput', \`✓ Mesh created: \${data.id}\`);
      } catch (e) {
        output('meshOutput', \`Error: \${e.message}\`, true);
      }
    }

    async function createAgent() {
      const agentId = document.getElementById('agentId').value;
      const contractId = 'contract-ui-' + Date.now();
      try {
        const res = await fetch(\`\${API}/agents\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: agentId,
            meshId: document.getElementById('agentMeshId').value,
            name: document.getElementById('agentName').value,
            role: document.getElementById('agentRole').value,
            contractVersionId: contractId,
            status: 'ACTIVE',
            createdAt: now,
            archivedAt: null,
          }),
        });
        const data = await res.json();
        output('agentOutput', \`✓ Agent created: \${data.id}\`);
        document.getElementById('contractAgentId').value = agentId;
      } catch (e) {
        output('agentOutput', \`Error: \${e.message}\`, true);
      }
    }

    async function createContract() {
      try {
        const res = await fetch(\`\${API}/contracts\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: document.getElementById('contractId').value,
            agentId: document.getElementById('contractAgentId').value,
            version: 1,
            persona: 'Demo',
            objectives: 'Process messages',
            successIndicators: 'Messages processed',
            budget: { monthlyUsdCap: 50, perActionUsdCap: 5 },
            workingHoursSchedule: { timezone: 'UTC', cronActive: '* * * * *' },
            accountBindingRefs: [],
            attentionPolicyRef: 'default',
            reviewCadence: 'P1D',
            contextPolicy: {
              compressors: [],
              weighting: [],
              budgets: {
                attentionTokensMax: 1000,
                actionTokensMax: 1000,
                handoffTokensMax: 500,
                reportTokensMax: 500,
                monthlyCompressionUsdCap: 10,
              },
              defaultsProfile: 'standard',
            },
            createdAt: now,
          }),
        });
        const data = await res.json();
        output('contractOutput', \`✓ Contract created: \${data.id}\`);
      } catch (e) {
        output('contractOutput', \`Error: \${e.message}\`, true);
      }
    }

    async function sendMessage() {
      try {
        const res = await fetch(\`\${API}/messages\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: document.getElementById('messageId').value,
            meshId: document.getElementById('messageMeshId').value,
            fromType: 'HUMAN',
            fromId: 'human:ui-user',
            fromMeshId: null,
            toType: 'AGENT',
            toId: document.getElementById('messageToAgent').value,
            topic: null,
            kind: 'ASK',
            replyToMessageId: null,
            threadId: 'thread-ui-' + Date.now(),
            contextRefs: [],
            contextPacketRef: null,
            expiresAt: null,
            priority: 'NORMAL',
            status: 'PENDING',
            deliveredAt: null,
            readAt: null,
            processedAt: null,
            createdAt: now,
            subject: document.getElementById('messageSubject').value,
            body: document.getElementById('messageBody').value,
          }),
        });
        const data = await res.json();
        output('messageOutput', \`✓ Message sent: \${data.id}\`);
      } catch (e) {
        output('messageOutput', \`Error: \${e.message}\`, true);
      }
    }

    async function scheduleTick() {
      try {
        const res = await fetch(\`\${API}/heartbeat/ticks\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: document.getElementById('tickId').value,
            agentId: document.getElementById('tickAgentId').value,
            scheduledFor: now,
            pickedUpAt: null,
            completedAt: null,
            workerId: 'ui-scheduler',
            leaseExpiresAt: null,
            actionChosen: null,
            actionOutcomeProse: null,
            actionOutcomeStatus: null,
            status: 'SCHEDULED',
          }),
        });
        const data = await res.json();
        output('tickOutput', \`✓ Tick scheduled: \${data.id}\`);
      } catch (e) {
        output('tickOutput', \`Error: \${e.message}\`, true);
      }
    }

    async function runHeartbeat() {
      try {
        const res = await fetch(\`\${API}/heartbeat/run-once\`, { method: 'POST' });
        const data = await res.json();
        output('heartbeatOutput', \`✓ Processed \${data.processed} ticks\`);
      } catch (e) {
        output('heartbeatOutput', \`Error: \${e.message}\`, true);
      }
    }

    async function getInbox() {
      try {
        const agentId = document.getElementById('inboxAgentId').value;
        const res = await fetch(\`\${API}/agents/\${agentId}/inbox\`);
        const data = await res.json();
        const inboxEl = document.getElementById('inboxOutput');
        
        if (data.messages.length === 0) {
          inboxEl.innerHTML = '<p>No messages in inbox</p>';
          return;
        }

        inboxEl.innerHTML = data.messages.map(msg => \`
          <div class="message-item">
            <strong>\${msg.subject}</strong> (Status: \${msg.status})
            <br>\${msg.body}
            <br><em>From: \${msg.fromId}</em>
          </div>
        \`).join('');
      } catch (e) {
        document.getElementById('inboxOutput').innerHTML = \`<div class="error">Error: \${e.message}</div>\`;
      }
    }
  </script>
</body>
</html>`;
}


function createAttentionPolicy(): AttentionPolicy {
  return {
    key: 'live-agents-demo-default',
    async decide(context) {
      const nextMessage = context.inbox.find((message) => message.status === 'PENDING');
      if (nextMessage) {
        return { type: 'ProcessMessage', messageId: nextMessage.id };
      }
      return {
        type: 'NoopRest',
        nextTickAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
    },
  };
}

function createHeartbeatRunner(stateStore: StateStore): Heartbeat {
  // Simple mock model for demo
  const mockModel: Model = {
    info: { provider: 'mock', modelId: 'demo-mock', capabilities: new Set() },
    capabilities: new Set(),
    hasCapability: () => false,
    async generate(_ctx: ExecutionContext, _request: ModelRequest): Promise<ModelResponse> {
      return {
        id: 'mock-res',
        content: '{"type":"NoopRest"}',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'demo-mock',
      };
    },
  };

  return createHeartbeat({
    stateStore,
    workerId: 'live-agents-demo-worker',
    concurrency: 4,
    model: mockModel,
    attentionPolicy: createAttentionPolicy(),
    actionExecutor: createActionExecutor(),
  });
}

export function createLiveAgentsDemoServer(config: LiveAgentsDemoConfig): LiveAgentsDemoApp {
  const host = config.host ?? '0.0.0.0';
  const port = config.port ?? Number.parseInt(process.env['LIVE_AGENTS_DEMO_PORT'] ?? '3600', 10);
  const heartbeat = createHeartbeatRunner(config.stateStore);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
        json(res, 200, {
          service: '@weaveintel/live-agents-demo',
          status: 'running',
          endpoints: {
            health: 'GET /health',
            ui: 'GET /ui',
            meshes: 'POST /api/meshes',
            agents: 'POST /api/agents',
            contracts: 'POST /api/contracts',
            accounts: 'POST /api/accounts',
            bindings: 'POST /api/account-bindings',
            messages: 'POST /api/messages',
            ticks: 'POST /api/heartbeat/ticks',
            runHeartbeat: 'POST /api/heartbeat/run-once',
            inbox: 'GET /api/agents/:agentId/inbox',
          },
          docs: 'See apps/live-agents-demo/README.md or visit /ui for web interface',
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/ui') {
        const body = htmlUI();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true, service: '@weaveintel/live-agents-demo' });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/meshes') {
        const mesh = JSON.parse(await readBody(req)) as Mesh;
        await config.stateStore.saveMesh(mesh);
        json(res, 201, { id: mesh.id });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/agents') {
        const agent = JSON.parse(await readBody(req)) as LiveAgent;
        await config.stateStore.saveAgent(agent);
        json(res, 201, { id: agent.id });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/contracts') {
        const contract = JSON.parse(await readBody(req)) as AgentContract;
        await config.stateStore.saveContract(contract);
        json(res, 201, { id: contract.id });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/accounts') {
        const account = JSON.parse(await readBody(req)) as Account;
        await config.stateStore.saveAccount(account);
        json(res, 201, { id: account.id });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/account-bindings') {
        const binding = JSON.parse(await readBody(req)) as AccountBinding;
        await config.stateStore.saveAccountBinding(binding);
        json(res, 201, { id: binding.id });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/messages') {
        const message = JSON.parse(await readBody(req)) as Message;
        await config.stateStore.saveMessage(message);
        json(res, 201, { id: message.id });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/heartbeat/ticks') {
        const tick = JSON.parse(await readBody(req)) as HeartbeatTick;
        await config.stateStore.saveHeartbeatTick(tick);
        json(res, 201, { id: tick.id });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/heartbeat/run-once') {
        const result = await heartbeat.tick(weaveContext({ userId: 'human:ops-admin-1' }));
        json(res, 200, result);
        return;
      }

      const inboxMatch = /^\/api\/agents\/([^/]+)\/inbox$/.exec(req.url ?? '');
      if (req.method === 'GET' && inboxMatch) {
        const agentId = inboxMatch[1] ?? '';
        if (!agentId) {
          badRequest(res, 'Agent id is required');
          return;
        }
        const inbox = await config.stateStore.listMessagesForRecipient('AGENT', agentId);
        json(res, 200, { agentId, count: inbox.length, messages: inbox });
        return;
      }

      notFound(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: message });
    }
  });

  server.listen(port, host);

  return {
    server,
    stateStore: config.stateStore,
    async stop() {
      await heartbeat.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}
