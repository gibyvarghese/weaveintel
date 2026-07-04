/**
 * Example 167: Vision-loop browser agent (P6-5)
 *
 * Shows how `visionLoop: true` enables an agent to:
 *   1. Call browser tools that return screenshots as base64 JSON
 *   2. Automatically detect the screenshot output
 *   3. Convert it to an ImageContent message injected into the conversation
 *   4. Allow the vision model to "see" the page and reason about it
 *
 * Two screenshot output formats are supported:
 *   - { format: 'png', base64: '<data>' }      — browser_screenshot style
 *   - { type: 'image', base64: '<data>', mimeType: 'image/png' } — standard
 *   - { type: 'image', url: 'https://...' }    — URL reference (no upload needed)
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveContext, weaveToolRegistry } from '@weaveintel/core';
import type { CapabilityId, Model } from '@weaveintel/core';

// ── Shared stub-model capabilities ────────────────────────────
const modelCaps = new Set<CapabilityId>();

// ── Fake screenshot data (1x1 transparent PNG) ───────────────
// In production this would come from a real browser automation tool.
const STUB_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ── Stub vision model ─────────────────────────────────────────
// A real deployment would use claude-opus-4-8 or claude-sonnet-4-6
// which support vision inputs natively.

let callIndex = 0;
const model: Model = {
  info: { provider: 'stub', modelId: 'vision-stub', capabilities: modelCaps },
  capabilities: modelCaps,
  hasCapability: () => false,
  async generate(_ctx, req) {
    callIndex++;

    // Check if any message has image content (array content)
    const hasImageContent = req.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p: unknown) => (p as { type?: string }).type === 'image'),
    );

    // First call: navigate and take screenshot
    if (callIndex === 1) {
      return {
        id: 'vision-1',
        model: 'vision-stub',
        finishReason: 'tool_calls',
        content: '',
        toolCalls: [
          { id: 'nav1', name: 'browser_navigate', arguments: '{"url":"https://example.com"}' },
        ],
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      };
    }

    // Second call: take screenshot after navigation
    if (callIndex === 2) {
      return {
        id: 'vision-2',
        model: 'vision-stub',
        finishReason: 'tool_calls',
        content: '',
        toolCalls: [
          { id: 'ss1', name: 'browser_screenshot', arguments: '{}' },
        ],
        usage: { promptTokens: 25, completionTokens: 10, totalTokens: 35 },
      };
    }

    // Third call: vision model sees the image and describes it
    if (callIndex >= 3) {
      const visionContext = hasImageContent
        ? 'I can see the screenshot! The page shows a simple "Example Domain" heading with minimal content and a link to "More information..." text.'
        : 'I did not receive a screenshot image.';
      return {
        id: 'vision-3',
        model: 'vision-stub',
        finishReason: 'stop',
        content: `Navigation complete. ${visionContext} The page appears to be a basic placeholder site. Task completed.`,
        toolCalls: [],
        usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
      };
    }

    return {
      id: 'vision-fallback',
      model: 'vision-stub',
      finishReason: 'stop',
      content: 'Done.',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  },
};

// ── Vision-enabled browser agent ──────────────────────────────

const browserTools = weaveToolRegistry();

browserTools.register({
  schema: {
    name: 'browser_navigate',
    description: 'Navigate the browser to a URL',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to navigate to' } },
      required: ['url'],
    },
  },
  async invoke(_ctx, input) {
    const { url } = input.arguments as { url: string };
    console.log(`  [tool] Navigating to: ${url}`);
    return { content: JSON.stringify({ success: true, url, title: 'Example Domain' }) };
  },
});

browserTools.register({
  schema: {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current browser view',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async invoke() {
    console.log('  [tool] Taking screenshot...');
    return {
      content: JSON.stringify({
        format: 'png',
        base64: STUB_PNG_BASE64,
        width: 1280,
        height: 720,
      }),
    };
  },
});

browserTools.register({
  schema: {
    name: 'browser_click',
    description: 'Click on an element at given coordinates',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['x', 'y'],
    },
  },
  async invoke(_ctx, input) {
    const { x, y } = input.arguments as { x: number; y: number };
    console.log(`  [tool] Clicking at (${x}, ${y})`);
    return { content: JSON.stringify({ success: true, clickedAt: { x, y } }) };
  },
});

const browserAgent = weaveAgent({
  name: 'vision-browser-agent',
  model,
  visionLoop: true,
  maxSteps: 10,
  tools: browserTools,
});

async function main(): Promise<void> {
  const ctx = weaveContext({ userId: 'demo', metadata: { sessionId: 'vision-loop-demo' } });

  console.log('=== Vision-Loop Browser Agent ===\n');
  console.log('Goal: Navigate to example.com, screenshot it, and describe what you see.\n');

  const result = await browserAgent.run(ctx, {
    messages: [
      {
        role: 'user',
        content: 'Go to https://example.com, take a screenshot, and tell me what you see on the page.',
      },
    ],
  });

  console.log('\n=== Result ===');
  console.log('Status:', result.status);
  console.log('Output:', result.output);
  console.log('Steps:', result.steps.length);

  for (const step of result.steps) {
    if (step.toolCall) {
      console.log(`  Step ${step.index}: [${step.toolCall.name}]`);
    } else if (step.content) {
      console.log(`  Step ${step.index}: [model response] ${step.content.slice(0, 80)}...`);
    }
  }

  console.log('\nToken usage:', JSON.stringify(result.usage));

  // Also demonstrate URL-based image injection
  console.log('\n=== URL-based Screenshot Example ===');
  callIndex = 0; // reset

  const urlModel: Model = {
    info: { provider: 'stub', modelId: 'url-vision-stub', capabilities: modelCaps },
    capabilities: modelCaps,
    hasCapability: () => false,
    async generate(_ctx, req) {
      const hasImg = req.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p: unknown) => (p as { type?: string }).type === 'image'),
      );
      if (!hasImg) {
        return {
          id: 'url-vision-1',
          model: 'url-vision-stub',
          finishReason: 'tool_calls',
          content: '',
          toolCalls: [{ id: 'ss2', name: 'url_screenshot', arguments: '{}' }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      }
      return {
        id: 'url-vision-2',
        model: 'url-vision-stub',
        finishReason: 'stop',
        content: 'Screenshot received via URL reference. Page analyzed successfully.',
        toolCalls: [],
        usage: { promptTokens: 20, completionTokens: 15, totalTokens: 35 },
      };
    },
  };

  const urlTools = weaveToolRegistry();
  urlTools.register({
    schema: {
      name: 'url_screenshot',
      description: 'Take screenshot and return as URL',
      parameters: { type: 'object', properties: {} },
    },
    async invoke() {
      return {
        content: JSON.stringify({
          type: 'image',
          url: 'https://screenshots.example.com/page-abc123.png',
          mimeType: 'image/png',
        }),
      };
    },
  });

  const urlAgent = weaveAgent({
    name: 'url-vision-agent',
    model: urlModel,
    visionLoop: true,
    tools: urlTools,
  });

  const urlResult = await urlAgent.run(ctx, {
    messages: [{ role: 'user', content: 'Screenshot the page' }],
  });
  console.log('URL-based screenshot status:', urlResult.status);
  console.log('Output:', urlResult.output);
}

main().catch(console.error);
