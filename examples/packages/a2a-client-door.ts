/**
 * Example: The A2A client through your own door (@weaveintel/a2a)
 *
 * ─── What this shows ────────────────────────────────────────────────────────
 * `weaveA2AClient()` normally uses the global `fetch`. A platform usually wants every outside call to go through its
 * own hardened door (address allow-list, timeouts, logging), and wants a fresh credential on each call because
 * tokens rotate. Pass `fetch` and `getHeaders`: discovery, messages and streams all go through them.
 *
 * Here the door is a small in-memory agent, so the example runs offline, and the credential rotates between calls.
 *
 * ─── When to reach for it ───────────────────────────────────────────────────
 * Whenever your agents call other agents over A2A from a server that controls its own network access. With no
 * options the client behaves exactly as before.
 *
 * Run: npx tsx examples/packages/a2a-client-door.ts
 */
import assert from 'node:assert/strict'
import { weaveContext } from '@weaveintel/core'
import { weaveA2AClient } from '@weaveintel/a2a'

const card = { name: 'Resolver', description: 'Triages incidents.', url: 'https://agents.example.test/a2a', version: '1', capabilities: {}, skills: [], defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'] }

async function main(): Promise<void> {
  const seen: string[] = []
  let token = 'token-1'

  const client = weaveA2AClient({
    // A fresh credential on every call (a token cache would sit behind this).
    getHeaders: async () => ({ authorization: `Bearer ${token}` }),
    // The platform's door. Here: an in-memory agent.
    fetch: async (url, init) => {
      seen.push(`${new Headers(init.headers).get('authorization') ?? ''} ${url}`)
      if (url.endsWith('agent-card.json')) return new Response(JSON.stringify(card), { status: 200, headers: { 'content-type': 'application/json' } })
      const req = JSON.parse(String(init.body)) as { id: string }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { id: 'task-9', contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const found = await client.discover('https://agents.example.test')
  assert.equal(found.name, 'Resolver')

  token = 'token-2' // the token rotated between calls
  const task = await client.sendMessage(weaveContext({ userId: 'user-1' }), 'https://agents.example.test/a2a', {
    message: { role: 'user', messageId: 'm1', parts: [{ text: 'Triage INC0010001' }] },
  })
  assert.equal(task.id, 'task-9')

  assert.deepEqual(seen.map((s) => s.split(' ').slice(0, 2).join(' ')), ['Bearer token-1', 'Bearer token-2'])
  console.log('Every call went through the door with the current credential:')
  for (const s of seen) console.log(' ', s.replace(/token-\d/, '•••'))
}

main().catch((e: unknown) => { console.error(e); process.exit(1) })
