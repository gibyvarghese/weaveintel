// The client reaches agents through the caller's own door when one is given: discovery, messages and streams all go
// through the injected fetch, with the per-call headers (a rotating credential) added.
import { describe, expect, it } from 'vitest'
import { weaveContext } from '@weaveintel/core'
import { weaveA2AClient } from './index.js'

const card = { name: 'Resolver', description: 'd', url: 'https://agents.example.test/a2a', version: '1', capabilities: {}, skills: [], defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'] }

describe('weaveA2AClient options', () => {
  it('uses the injected fetch and adds the headers to every call', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    let token = 't1'
    const client = weaveA2AClient({
      getHeaders: async () => ({ authorization: `Bearer ${token}` }),
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers as Record<string, string> })
        if (url.endsWith('agent-card.json')) return new Response(JSON.stringify(card), { status: 200, headers: { 'content-type': 'application/json' } })
        const req = JSON.parse(String(init.body)) as { id: string }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { id: 't9', contextId: 'c', status: { state: 'TASK_STATE_COMPLETED' } } }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    const found = await client.discover('https://agents.example.test')
    expect(found.name).toBe('Resolver')
    token = 't2'
    const task = await client.sendMessage(weaveContext({ userId: 'u' }), 'https://agents.example.test/a2a', { message: { role: 'ROLE_USER', messageId: 'm1', parts: [{ text: 'hi' }] } } as never)
    expect(task.id).toBe('t9')
    expect(calls.map((c) => c.headers['authorization'])).toEqual(['Bearer t1', 'Bearer t2'])
  })
})
