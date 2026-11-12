// SPDX-License-Identifier: MIT
/**
 * @weaveintel/routing — Rule router tests
 *
 * No network, no models, no keys: every "model call" here is a small local
 * function that either returns a string or throws. Each test checks the
 * decision data and the plain-English explanation, not just that a value
 * came back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeaveIntelError } from '@weaveintel/core';
import type { ErrorCode } from '@weaveintel/core';
import { createRuleRouter } from './rule-router.js';
import type { DataRule, RouteRequest, RouteRule, RouteTarget, RuleRouterOptions } from './rule-router.js';

// ─── Fixtures ────────────────────────────────────────────────

const groq: RouteTarget = {
  key: 'groq-llama',
  providerId: 'groq',
  modelId: 'llama-3.3-70b',
  displayName: 'Groq llama-3.3-70b',
  kind: 'chat',
  enabled: true,
  capabilities: ['tools'],
  contextTokens: 128_000,
  region: 'us',
  inputPricePerMTok: 0.5,
  outputPricePerMTok: 1,
  typicalLatencyMs: 300,
};

const azure: RouteTarget = {
  key: 'azure-gpt4o',
  providerId: 'azure',
  modelId: 'gpt-4o',
  displayName: 'Azure gpt-4o',
  kind: 'chat',
  enabled: true,
  capabilities: ['tools', 'vision'],
  contextTokens: 128_000,
  region: 'eu',
  inputPricePerMTok: 2,
  outputPricePerMTok: 10,
  typicalLatencyMs: 900,
};

const openaiLarge: RouteTarget = {
  key: 'openai-3-large',
  providerId: 'openai',
  modelId: 'text-embedding-3-large',
  displayName: 'OpenAI text-embedding-3-large',
  kind: 'embedding',
  enabled: true,
  vectorSpace: 'text-embedding-3-large@512',
};

const azureLarge: RouteTarget = {
  key: 'azure-3-large',
  providerId: 'azure',
  modelId: 'text-embedding-3-large',
  displayName: 'Azure text-embedding-3-large',
  kind: 'embedding',
  enabled: true,
  vectorSpace: 'text-embedding-3-large@512',
};

const mistralEmbed: RouteTarget = {
  key: 'mistral-embed',
  providerId: 'mistral',
  modelId: 'mistral-embed',
  displayName: 'Mistral embed',
  kind: 'embedding',
  enabled: true,
  vectorSpace: 'mistral-embed@1024',
};

function chatRule(keys: readonly string[], extra: Partial<RouteRule> = {}): RouteRule {
  return {
    key: 'chat-default',
    purpose: 'chat',
    steps: keys.map((targetKey, index) => ({ targetKey, order: (index + 1) * 10 })),
    ...extra,
  };
}

function embedRule(keys: readonly string[]): RouteRule {
  return {
    key: 'embed-default',
    purpose: 'embed',
    steps: keys.map((targetKey, index) => ({ targetKey, order: (index + 1) * 10 })),
  };
}

function fail(code: ErrorCode, message: string): WeaveIntelError {
  return new WeaveIntelError({ code, message, retryable: code === 'RATE_LIMITED' });
}

/** Awaits a promise that must reject with a WeaveIntelError and hands the error back. */
async function rejection(promise: Promise<unknown>): Promise<WeaveIntelError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WeaveIntelError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

const CHAT: RouteRequest = { purpose: 'chat' };
const EMBED: RouteRequest = { purpose: 'embed' };

afterEach(() => {
  vi.useRealTimers();
});

// ─── 1. First choice ─────────────────────────────────────────

describe('rule router — choosing', () => {
  it('picks the first step of the chat rule and names it', async () => {
    const router = createRuleRouter({ targets: [groq, azure], rules: [chatRule(['groq-llama', 'azure-gpt4o'])] });

    const plan = router.plan(CHAT);
    expect(plan.ruleKey).toBe('chat-default');
    expect(plan.chosen).toBe('groq-llama');
    expect(plan.order).toEqual(['groq-llama', 'azure-gpt4o']);
    expect(plan.sticky).toBe(false);
    expect(plan.vectorSpace).toBeUndefined();
    expect(plan.candidates.map((c) => [c.targetKey, c.eligible, c.order])).toEqual([
      ['groq-llama', true, 10],
      ['azure-gpt4o', true, 20],
    ]);
    expect(plan.explanation).toBe('Sent to Groq llama-3.3-70b: first choice for chat.');

    const seen: string[] = [];
    const outcome = await router.run(CHAT, async (target, info) => {
      seen.push(`${target.key}#${info.attemptNumber}`);
      return 'hello';
    });
    expect(outcome.value).toBe('hello');
    expect(outcome.target.key).toBe('groq-llama');
    expect(seen).toEqual(['groq-llama#1']);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]).toMatchObject({ targetKey: 'groq-llama', ok: true });
    expect(outcome.explanation).toBe(plan.explanation);
  });

  it('honours step order and ignores switched-off steps and rules', () => {
    const rules: RouteRule[] = [
      { key: 'z-chat', purpose: 'chat', steps: [{ targetKey: 'azure-gpt4o', order: 1 }] },
      { key: 'a-chat', purpose: 'chat', enabled: false, steps: [{ targetKey: 'azure-gpt4o', order: 1 }] },
      {
        key: 'm-chat',
        purpose: 'chat',
        steps: [
          { targetKey: 'azure-gpt4o', order: 5, enabled: false },
          { targetKey: 'azure-gpt4o', order: 30 },
          { targetKey: 'groq-llama', order: 20 },
        ],
      },
    ];
    const plan = createRuleRouter({ targets: [groq, azure], rules }).plan(CHAT);
    // "a-chat" is off, so the lowest enabled key wins: "m-chat".
    expect(plan.ruleKey).toBe('m-chat');
    expect(plan.order).toEqual(['groq-llama', 'azure-gpt4o']);
    expect(plan.candidates.map((c) => c.order)).toEqual([20, 30]);
  });

  it('says so when no rule covers the purpose', async () => {
    const router = createRuleRouter({ targets: [groq], rules: [chatRule(['groq-llama'])] });
    const plan = router.plan({ purpose: 'judge' });
    expect(plan.ruleKey).toBeUndefined();
    expect(plan.candidates).toEqual([]);
    expect(plan.order).toEqual([]);
    expect(plan.chosen).toBeUndefined();
    expect(plan.explanation).toContain('no routing rule for this purpose');

    let called = false;
    const error = await rejection(
      router.run({ purpose: 'judge' }, async () => {
        called = true;
        return 'x';
      }),
    );
    expect(called).toBe(false);
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('no routing rule for this purpose');
  });
});

// ─── 2. Every reason a step can be skipped ───────────────────

describe('rule router — skipped steps', () => {
  /** Plans a two-step chat route: the target under test first, Groq second. */
  function planWith(
    first: RouteTarget | undefined,
    opts: { rule?: Partial<RouteRule>; router?: Partial<RuleRouterOptions>; request?: Partial<RouteRequest> } = {},
  ) {
    const firstKey = first?.key ?? 'ghost';
    const router = createRuleRouter({
      targets: first ? [first, groq] : [groq],
      rules: [chatRule([firstKey, 'groq-llama'], opts.rule)],
      ...opts.router,
    });
    const plan = router.plan({ ...CHAT, ...opts.request });
    const candidate = plan.candidates[0];
    if (candidate === undefined) throw new Error('expected a first candidate');
    return { plan, candidate };
  }

  it('switched off — the model itself', () => {
    const { plan, candidate } = planWith({ ...azure, enabled: false });
    expect(candidate).toMatchObject({ targetKey: 'azure-gpt4o', eligible: false, dropped: 'switched_off' });
    expect(candidate.detail).toBe('the model is switched off');
    expect(plan.chosen).toBe('groq-llama');
    expect(plan.order).toEqual(['groq-llama']);
    expect(plan.explanation).toBe(
      'Sent to Groq llama-3.3-70b: second choice for chat. Skipped Azure gpt-4o (switched off).',
    );
  });

  it('switched off — the whole provider', () => {
    const { candidate } = planWith({ ...azure, providerEnabled: false });
    expect(candidate.dropped).toBe('switched_off');
    expect(candidate.detail).toBe('its provider is switched off');
  });

  it('provider not allowed', () => {
    const { plan, candidate } = planWith(azure, { router: { dataRule: { allowedProviders: ['groq'] } } });
    expect(candidate).toMatchObject({ eligible: false, dropped: 'provider_not_allowed' });
    expect(candidate.detail).toContain('azure');
    expect(plan.chosen).toBe('groq-llama');
    expect(plan.explanation).toContain('Skipped Azure gpt-4o (provider not allowed for this workspace).');
  });

  it('an empty allowed-provider list allows nothing', () => {
    const { plan } = planWith(azure, { router: { dataRule: { allowedProviders: [] } } });
    expect(plan.candidates.map((c) => c.dropped)).toEqual(['provider_not_allowed', 'provider_not_allowed']);
    expect(plan.chosen).toBeUndefined();
    expect(plan.explanation).toMatch(/^No model is available for chat: /);
  });

  it('region not allowed — including a model with no region recorded', () => {
    const wrongRegion = planWith(azure, { router: { dataRule: { allowedRegions: ['us'] } } });
    expect(wrongRegion.candidate).toMatchObject({ eligible: false, dropped: 'region_not_allowed' });
    expect(wrongRegion.candidate.detail).toContain('eu');
    expect(wrongRegion.plan.chosen).toBe('groq-llama');
    expect(wrongRegion.plan.explanation).toBe(
      'Sent to Groq llama-3.3-70b: second choice for chat. Skipped Azure gpt-4o (region not allowed for this workspace).',
    );

    const { region: _region, ...noRegion } = azure;
    const unknownRegion = planWith(noRegion, { router: { dataRule: { allowedRegions: ['us'] } } });
    expect(unknownRegion.candidate.dropped).toBe('region_not_allowed');
    expect(unknownRegion.candidate.detail).toContain('no region is recorded');
  });

  it('missing capability — names which, merging rule and request needs', () => {
    const { plan, candidate } = planWith(
      { ...azure, capabilities: ['tools'] },
      { rule: { needs: { capabilities: ['tools'] } }, request: { needs: { capabilities: ['vision', 'structured_output'] } } },
    );
    expect(candidate).toMatchObject({ eligible: false, dropped: 'missing_capability' });
    expect(candidate.detail).toBe('missing capability: vision, structured_output');
    // Groq lacks them as well, so nothing is left and the sentence says why for each.
    expect(plan.chosen).toBeUndefined();
    expect(plan.explanation).toBe(
      'No model is available for chat: Azure gpt-4o does not support vision and structured_output, ' +
        'and Groq llama-3.3-70b does not support vision and structured_output.',
    );
  });

  it('context too small — the larger of the rule and request sizes applies', () => {
    const { plan, candidate } = planWith(
      { ...azure, contextTokens: 8_000 },
      { rule: { needs: { minContextTokens: 4_000 } }, request: { needs: { minContextTokens: 32_000 } } },
    );
    expect(candidate).toMatchObject({ eligible: false, dropped: 'context_too_small' });
    expect(candidate.detail).toContain('32000');
    expect(candidate.detail).toContain('8000');
    expect(plan.chosen).toBe('groq-llama');
    expect(plan.explanation).toContain('Skipped Azure gpt-4o (context window too small).');
  });

  it('over the cost ceiling — blended price; a model with no prices is kept', () => {
    // Azure blends to (2 + 10) / 2 = 6; Groq to (0.5 + 1) / 2 = 0.75.
    const { plan, candidate } = planWith(azure, { rule: { maxCostPerMTok: 5 } });
    expect(candidate).toMatchObject({ eligible: false, dropped: 'over_cost_ceiling' });
    expect(candidate.detail).toContain('6');
    expect(plan.chosen).toBe('groq-llama');
    expect(plan.explanation).toContain('Skipped Azure gpt-4o (over the cost limit for this route).');

    expect(planWith(azure, { rule: { maxCostPerMTok: 6 } }).candidate.eligible).toBe(true);

    const { inputPricePerMTok: _in, outputPricePerMTok: _out, ...unpriced } = azure;
    const kept = planWith(unpriced, { rule: { maxCostPerMTok: 0.1 } });
    expect(kept.candidate.eligible).toBe(true);
    expect(kept.plan.candidates[1]?.dropped).toBe('over_cost_ceiling');
    expect(kept.plan.chosen).toBe('azure-gpt4o');
  });

  it('too slow — a live measurement beats the typical figure; unknown speed is kept', () => {
    const typical = planWith(azure, { rule: { maxLatencyMs: 500 } });
    expect(typical.candidate).toMatchObject({ eligible: false, dropped: 'too_slow' });
    expect(typical.candidate.detail).toContain('900');
    expect(typical.plan.chosen).toBe('groq-llama');
    expect(typical.plan.explanation).toContain('Skipped Azure gpt-4o (too slow for this route).');

    // Measured: Azure is quick today and Groq is crawling.
    const measured = planWith(azure, {
      rule: { maxLatencyMs: 500 },
      router: { health: (key) => (key === 'azure-gpt4o' ? { latencyMs: 200 } : { latencyMs: 4_000 }) },
    });
    expect(measured.candidate.eligible).toBe(true);
    expect(measured.plan.candidates[1]?.dropped).toBe('too_slow');
    expect(measured.plan.chosen).toBe('azure-gpt4o');

    const { typicalLatencyMs: _latency, ...unmeasured } = azure;
    expect(planWith(unmeasured, { rule: { maxLatencyMs: 1 } }).candidate.eligible).toBe(true);
  });

  it('unknown target', () => {
    const { plan, candidate } = planWith(undefined);
    expect(candidate).toMatchObject({ targetKey: 'ghost', eligible: false, dropped: 'unknown_target', providerId: '' });
    expect(plan.chosen).toBe('groq-llama');
    expect(plan.explanation).toBe(
      'Sent to Groq llama-3.3-70b: second choice for chat. Skipped "ghost" (not in the model list).',
    );
  });

  it('wrong kind — an embedding model on a chat route, and a chat model on an embedding route', () => {
    const { plan, candidate } = planWith(openaiLarge);
    expect(candidate).toMatchObject({ eligible: false, dropped: 'wrong_kind' });
    expect(plan.chosen).toBe('groq-llama');
    expect(plan.explanation).toContain(
      'Skipped OpenAI text-embedding-3-large (an embedding model, not a chat model).',
    );

    const embedPlan = createRuleRouter({
      targets: [groq, openaiLarge],
      rules: [embedRule(['groq-llama', 'openai-3-large'])],
    }).plan(EMBED);
    expect(embedPlan.candidates[0]).toMatchObject({ eligible: false, dropped: 'wrong_kind' });
    expect(embedPlan.chosen).toBe('openai-3-large');
    expect(embedPlan.explanation).toBe(
      'Sent to OpenAI text-embedding-3-large: second choice for embeddings. ' +
        'Skipped Groq llama-3.3-70b (not an embedding model).',
    );
  });

  it('reports the first reason that applies', () => {
    // Switched off AND from a provider that is not allowed: "switched off" comes first.
    const { candidate } = planWith({ ...azure, enabled: false }, { router: { dataRule: { allowedProviders: ['groq'] } } });
    expect(candidate.dropped).toBe('switched_off');
  });
});

// ─── 3 & 4. Fail-over ────────────────────────────────────────

describe('rule router — fail-over', () => {
  it('moves to the second model when the first fails, and says so', async () => {
    let tick = 1_000;
    const router = createRuleRouter({
      targets: [groq, azure],
      rules: [chatRule(['groq-llama', 'azure-gpt4o'])],
      now: () => (tick += 25),
    });
    const calls: string[] = [];
    const outcome = await router.run(CHAT, async (target, info) => {
      calls.push(`${target.key}#${info.attemptNumber}`);
      if (target.key === 'groq-llama') throw fail('RATE_LIMITED', 'slow down');
      return `answer from ${target.modelId}`;
    });

    expect(calls).toEqual(['groq-llama#1', 'azure-gpt4o#2']);
    expect(outcome.value).toBe('answer from gpt-4o');
    expect(outcome.target.key).toBe('azure-gpt4o');
    expect(outcome.plan.chosen).toBe('groq-llama');
    expect(outcome.attempts).toEqual([
      { targetKey: 'groq-llama', ok: false, errorCode: 'RATE_LIMITED', errorMessage: 'slow down', durationMs: 25 },
      { targetKey: 'azure-gpt4o', ok: true, durationMs: 25 },
    ]);
    expect(outcome.explanation).toBe(
      'Sent to Groq llama-3.3-70b: first choice for chat. ' +
        'Tried Groq llama-3.3-70b first; it failed (rate limited), so the answer came from Azure gpt-4o.',
    );
  });

  it('fails over on a plain Error with no code', async () => {
    const router = createRuleRouter({ targets: [groq, azure], rules: [chatRule(['groq-llama', 'azure-gpt4o'])] });
    const outcome = await router.run(CHAT, async (target) => {
      if (target.key === 'groq-llama') throw new Error('socket hang up');
      return 'ok';
    });
    expect(outcome.target.key).toBe('azure-gpt4o');
    expect(outcome.attempts[0]).toMatchObject({ ok: false, errorMessage: 'socket hang up' });
    expect(outcome.attempts[0]?.errorCode).toBeUndefined();
    expect(outcome.explanation).toContain('it failed (error), so the answer came from Azure gpt-4o.');
  });

  it('does not fail over on INVALID_INPUT: the error comes straight back', async () => {
    const router = createRuleRouter({
      targets: [groq, azure],
      rules: [chatRule(['groq-llama', 'azure-gpt4o'])],
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });
    const calls: string[] = [];
    const original = fail('INVALID_INPUT', 'the prompt is empty');
    const error = await rejection(
      router.run(CHAT, async (target) => {
        calls.push(target.key);
        throw original;
      }),
    );
    expect(error).toBe(original);
    expect(calls).toEqual(['groq-llama']);
    // A bad request is not the model's fault, so the model is not paused by it.
    expect(router.health().find((h) => h.targetKey === 'groq-llama')).toMatchObject({
      state: 'closed',
      consecutiveFailures: 0,
    });
    expect(router.plan(CHAT).chosen).toBe('groq-llama');
  });

  it('lets the caller decide what fails over', async () => {
    const router = createRuleRouter({ targets: [groq, azure], rules: [chatRule(['groq-llama', 'azure-gpt4o'])] });
    const calls: string[] = [];
    const error = await rejection(
      router.run(
        CHAT,
        async (target) => {
          calls.push(target.key);
          throw fail('AUTH_FAILED', 'bad key');
        },
        { shouldFailOver: (e) => !(e instanceof WeaveIntelError && e.code === 'AUTH_FAILED') },
      ),
    );
    expect(error.code).toBe('AUTH_FAILED');
    expect(calls).toEqual(['groq-llama']);
  });

  it('when every model fails, rejects with the attempts and a readable message', async () => {
    const router = createRuleRouter({ targets: [groq, azure], rules: [chatRule(['groq-llama', 'azure-gpt4o'])] });
    const error = await rejection(
      router.run(CHAT, async (target) => {
        throw fail(target.key === 'groq-llama' ? 'RATE_LIMITED' : 'TIMEOUT', `${target.key} is down`);
      }),
    );
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe(
      'No model could answer for chat: Groq llama-3.3-70b failed (rate limited) and Azure gpt-4o failed (timed out).',
    );
    const details = error.details as { plan: { chosen?: string }; attempts: { targetKey: string; errorMessage?: string }[] };
    expect(details.plan.chosen).toBe('groq-llama');
    expect(details.attempts.map((a) => [a.targetKey, a.errorMessage])).toEqual([
      ['groq-llama', 'groq-llama is down'],
      ['azure-gpt4o', 'azure-gpt4o is down'],
    ]);
    // The details must survive being written to a log or a database row.
    expect(JSON.parse(JSON.stringify(error.details))).toEqual(error.details);
  });
});

// ─── 5. Pausing a failing model ──────────────────────────────

describe('rule router — pausing a failing model', () => {
  it('skips a model after repeated failures without calling it, then tries it again after the wait', async () => {
    // The breaker keeps time with the system clock, so only the clock is faked.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const router = createRuleRouter({
      targets: [groq, azure],
      rules: [chatRule(['groq-llama', 'azure-gpt4o'])],
      breaker: { failureThreshold: 2, cooldownMs: 1_000 },
    });
    let groqHealthy = false;
    const calls: string[] = [];
    const attempt = async (target: RouteTarget): Promise<string> => {
      calls.push(target.key);
      if (target.key === 'groq-llama' && !groqHealthy) throw fail('PROVIDER_ERROR', 'boom');
      return target.key;
    };

    // Two failures in a row reach the threshold.
    await router.run(CHAT, attempt);
    expect(router.plan(CHAT).chosen).toBe('groq-llama');
    await router.run(CHAT, attempt);
    expect(calls).toEqual(['groq-llama', 'azure-gpt4o', 'groq-llama', 'azure-gpt4o']);
    expect(router.health()).toEqual([
      { targetKey: 'groq-llama', state: 'open', consecutiveFailures: 2 },
      { targetKey: 'azure-gpt4o', state: 'closed', consecutiveFailures: 0 },
    ]);

    // Now it is paused: planned around, and not called.
    const paused = router.plan(CHAT);
    expect(paused.candidates[0]).toMatchObject({ targetKey: 'groq-llama', eligible: false, dropped: 'circuit_open' });
    expect(paused.order).toEqual(['azure-gpt4o']);
    expect(paused.explanation).toBe(
      'Sent to Azure gpt-4o: second choice for chat. Skipped Groq llama-3.3-70b (paused after repeated failures).',
    );
    const third = await router.run(CHAT, attempt);
    expect(third.target.key).toBe('azure-gpt4o');
    expect(third.attempts).toHaveLength(1);
    expect(calls.filter((key) => key === 'groq-llama')).toHaveLength(2);

    // Just before the wait is over it is still paused.
    vi.setSystemTime(Date.now() + 999);
    expect(router.plan(CHAT).chosen).toBe('azure-gpt4o');

    // After the wait it is tried again, and a success puts it back in service.
    vi.setSystemTime(Date.now() + 2);
    groqHealthy = true;
    const retryPlan = router.plan(CHAT);
    expect(retryPlan.chosen).toBe('groq-llama');
    expect(retryPlan.candidates[0]?.eligible).toBe(true);
    const fourth = await router.run(CHAT, attempt);
    expect(fourth.target.key).toBe('groq-llama');
    expect(calls.filter((key) => key === 'groq-llama')).toHaveLength(3);
    expect(router.health()[0]).toEqual({ targetKey: 'groq-llama', state: 'closed', consecutiveFailures: 0 });
  });

  it('when the only usable model is paused, the failure is marked as worth retrying', async () => {
    const router = createRuleRouter({
      targets: [groq],
      rules: [chatRule(['groq-llama'])],
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });
    await rejection(
      router.run(CHAT, async () => {
        throw fail('TIMEOUT', 'too slow');
      }),
    );
    let called = false;
    const error = await rejection(
      router.run(CHAT, async () => {
        called = true;
        return 'x';
      }),
    );
    expect(called).toBe(false);
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('No model is available for chat: Groq llama-3.3-70b is paused after repeated failures.');

    router.reset();
    expect(router.plan(CHAT).chosen).toBe('groq-llama');
  });

  it('records a model that was paused between planning and calling as skipped, not attempted', async () => {
    const router = createRuleRouter({
      targets: [groq, azure],
      rules: [chatRule(['groq-llama', 'azure-gpt4o'])],
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });
    const outerCalls: string[] = [];
    const error = await rejection(
      router.run(CHAT, async (target) => {
        outerCalls.push(target.key);
        // While this request is in flight, another request fails on both models and pauses them.
        await rejection(
          router.run(CHAT, async () => {
            throw fail('PROVIDER_ERROR', 'down');
          }),
        );
        throw fail('PROVIDER_ERROR', 'down');
      }),
    );
    expect(outerCalls).toEqual(['groq-llama']);
    expect(error.code).toBe('PROVIDER_ERROR');
    const details = error.details as { attempts: { targetKey: string; ok: boolean; skipped?: string }[] };
    expect(details.attempts).toHaveLength(2);
    expect(details.attempts[0]).toMatchObject({ targetKey: 'groq-llama', ok: false });
    expect(details.attempts[0]?.skipped).toBeUndefined();
    expect(details.attempts[1]).toMatchObject({ targetKey: 'azure-gpt4o', ok: false, skipped: 'circuit_open' });
    expect(error.message).toBe(
      'No model could answer for chat: Groq llama-3.3-70b failed (provider error) and ' +
        'Azure gpt-4o was skipped (paused after repeated failures).',
    );
  });
});

// ─── 6. Staying with one model during a run ──────────────────

describe('rule router — stickiness', () => {
  function stickyRouter(rule: Partial<RouteRule> = {}, extra: Partial<RuleRouterOptions> = {}) {
    return createRuleRouter({
      targets: [groq, azure],
      rules: [chatRule(['groq-llama', 'azure-gpt4o'], rule)],
      breaker: { failureThreshold: 100, cooldownMs: 60_000 },
      ...extra,
    });
  }

  it('starts the next request of the same run at the model that answered, and forgets it when that model fails', async () => {
    const router = stickyRouter();
    const down = new Set<string>(['groq-llama']);
    const calls: string[] = [];
    const attempt = async (target: RouteTarget): Promise<string> => {
      calls.push(target.key);
      if (down.has(target.key)) throw fail('RATE_LIMITED', 'busy');
      return target.key;
    };
    const runOne: RouteRequest = { purpose: 'chat', affinityKey: 'run-1' };
    const runTwo: RouteRequest = { purpose: 'chat', affinityKey: 'run-2' };

    // Request 1 of run-1 falls over from Groq to Azure.
    const first = await router.run(runOne, attempt);
    expect(first.target.key).toBe('azure-gpt4o');
    expect(first.plan.sticky).toBe(false);
    down.clear();

    // Request 2 of run-1 starts at Azure even though Groq is healthy again.
    const plan = router.plan(runOne);
    expect(plan.sticky).toBe(true);
    expect(plan.chosen).toBe('azure-gpt4o');
    expect(plan.order).toEqual(['azure-gpt4o', 'groq-llama']);
    expect(plan.explanation).toBe(
      'Sent to Azure gpt-4o: it answered earlier in this run, so chat stays with it.',
    );
    calls.length = 0;
    const second = await router.run(runOne, attempt);
    expect(second.target.key).toBe('azure-gpt4o');
    expect(calls).toEqual(['azure-gpt4o']);

    // A different run, and a request with no affinity key, start at the first choice.
    const other = router.plan(runTwo);
    expect(other.sticky).toBe(false);
    expect(other.order).toEqual(['groq-llama', 'azure-gpt4o']);
    expect(router.plan(CHAT).chosen).toBe('groq-llama');
    // The same key under another tenant is a different run.
    expect(router.plan({ ...runOne, tenantId: 'tenant-b' }).sticky).toBe(false);

    // Azure now fails for run-1 (and so does Groq): the memory is cleared.
    down.add('groq-llama');
    down.add('azure-gpt4o');
    calls.length = 0;
    const error = await rejection(router.run(runOne, attempt));
    expect(calls).toEqual(['azure-gpt4o', 'groq-llama']);
    expect(error.code).toBe('PROVIDER_ERROR');
    const after = router.plan(runOne);
    expect(after.sticky).toBe(false);
    expect(after.order).toEqual(['groq-llama', 'azure-gpt4o']);
  });

  it('a sticky model that fails hands over, and the run then sticks to the model that answered', async () => {
    const router = stickyRouter();
    const request: RouteRequest = { purpose: 'chat', affinityKey: 'run-9' };
    const down = new Set<string>(['groq-llama']);
    const attempt = async (target: RouteTarget): Promise<string> => {
      if (down.has(target.key)) throw fail('TIMEOUT', 'slow');
      return target.key;
    };
    await router.run(request, attempt); // sticks to Azure
    down.clear();
    down.add('azure-gpt4o');
    const outcome = await router.run(request, attempt);
    expect(outcome.plan.sticky).toBe(true);
    expect(outcome.target.key).toBe('groq-llama');
    expect(outcome.explanation).toBe(
      'Sent to Azure gpt-4o: it answered earlier in this run, so chat stays with it. ' +
        'Tried Azure gpt-4o first; it failed (timed out), so the answer came from Groq llama-3.3-70b.',
    );
    const next = router.plan(request);
    expect(next.sticky).toBe(true);
    expect(next.chosen).toBe('groq-llama');
  });

  it('does not stick to a model that is no longer usable', async () => {
    const targets: RouteTarget[] = [groq, azure];
    const router = stickyRouter({}, { targets: () => targets });
    const request: RouteRequest = { purpose: 'chat', affinityKey: 'run-3' };
    await router.run(request, async (target) => {
      if (target.key === 'groq-llama') throw fail('RATE_LIMITED', 'busy');
      return 'ok';
    });
    expect(router.plan(request).chosen).toBe('azure-gpt4o');
    targets[1] = { ...azure, enabled: false };
    const plan = router.plan(request);
    expect(plan.sticky).toBe(false);
    expect(plan.chosen).toBe('groq-llama');
  });

  it('can be switched off per rule, and remembers only a bounded number of runs', async () => {
    const failFirst = async (target: RouteTarget): Promise<string> => {
      if (target.key === 'groq-llama') throw fail('RATE_LIMITED', 'busy');
      return 'ok';
    };

    const loose = stickyRouter({ sticky: false });
    await loose.run({ purpose: 'chat', affinityKey: 'run-1' }, failFirst);
    expect(loose.plan({ purpose: 'chat', affinityKey: 'run-1' })).toMatchObject({ sticky: false, chosen: 'groq-llama' });

    const small = stickyRouter({}, { maxAffinityEntries: 2 });
    for (const key of ['run-1', 'run-2', 'run-3']) await small.run({ purpose: 'chat', affinityKey: key }, failFirst);
    expect(small.plan({ purpose: 'chat', affinityKey: 'run-1' }).sticky).toBe(false); // oldest, forgotten
    expect(small.plan({ purpose: 'chat', affinityKey: 'run-2' }).sticky).toBe(true);
    expect(small.plan({ purpose: 'chat', affinityKey: 'run-3' }).sticky).toBe(true);

    small.reset();
    expect(small.plan({ purpose: 'chat', affinityKey: 'run-3' }).sticky).toBe(false);
  });
});

// ─── 7. Embeddings never change model ────────────────────────

describe('rule router — embeddings', () => {
  it('never sends to a model with different vectors, even when the first choice fails', async () => {
    const router = createRuleRouter({
      targets: [openaiLarge, mistralEmbed],
      rules: [embedRule(['openai-3-large', 'mistral-embed'])],
    });

    const plan = router.plan(EMBED);
    expect(plan.vectorSpace).toBe('text-embedding-3-large@512');
    expect(plan.order).toEqual(['openai-3-large']);
    expect(plan.candidates[1]).toMatchObject({
      targetKey: 'mistral-embed',
      eligible: false,
      dropped: 'different_vector_space',
      detail: 'vectors from mistral-embed@1024 cannot be compared with vectors from text-embedding-3-large@512',
    });
    expect(plan.explanation).toBe(
      'Sent to OpenAI text-embedding-3-large: first choice for embeddings. ' +
        "Skipped Mistral embed (its vectors cannot be mixed with the first choice's).",
    );

    const calls: string[] = [];
    const error = await rejection(
      router.run(EMBED, async (target) => {
        calls.push(target.key);
        throw fail('RATE_LIMITED', 'busy');
      }),
    );
    expect(calls).toEqual(['openai-3-large']);
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.message).toBe(
      'No model could answer for embeddings: OpenAI text-embedding-3-large failed (rate limited). ' +
        "Skipped Mistral embed (its vectors cannot be mixed with the first choice's). " +
        'The request was not sent to a different embedding model, because vectors from different models cannot be compared.',
    );
  });

  it('falls back to the same model and size on another provider', async () => {
    const router = createRuleRouter({
      targets: [openaiLarge, mistralEmbed, azureLarge],
      rules: [embedRule(['openai-3-large', 'mistral-embed', 'azure-3-large'])],
    });
    const plan = router.plan(EMBED);
    expect(plan.order).toEqual(['openai-3-large', 'azure-3-large']);

    const calls: string[] = [];
    const outcome = await router.run(EMBED, async (target) => {
      calls.push(target.key);
      if (target.providerId === 'openai') throw fail('RATE_LIMITED', 'busy');
      return [0.1, 0.2];
    });
    expect(calls).toEqual(['openai-3-large', 'azure-3-large']);
    expect(outcome.target.key).toBe('azure-3-large');
    expect(outcome.plan.vectorSpace).toBe('text-embedding-3-large@512');
    expect(outcome.explanation).toContain(
      'Tried OpenAI text-embedding-3-large first; it failed (rate limited), so the answer came from Azure text-embedding-3-large.',
    );
  });

  it('a switched-off first choice still fixes the vectors: nothing else may stand in for it', async () => {
    const router = createRuleRouter({
      targets: [{ ...openaiLarge, enabled: false }, mistralEmbed],
      rules: [embedRule(['openai-3-large', 'mistral-embed'])],
    });
    const plan = router.plan(EMBED);
    expect(plan.vectorSpace).toBe('text-embedding-3-large@512');
    expect(plan.candidates.map((c) => c.dropped)).toEqual(['switched_off', 'different_vector_space']);
    expect(plan.order).toEqual([]);
    expect(plan.chosen).toBeUndefined();
    expect(plan.explanation).toBe(
      'No model is available for embeddings: OpenAI text-embedding-3-large is switched off, ' +
        "and Mistral embed was skipped because its vectors cannot be mixed with the first choice's.",
    );

    let called = false;
    const error = await rejection(
      router.run(EMBED, async () => {
        called = true;
        return [];
      }),
    );
    expect(called).toBe(false);
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message).toContain('The request was not sent to a different embedding model');
  });

  it('uses the model id as the vector space when none is recorded, and stickiness cannot cross spaces', async () => {
    const { vectorSpace: _a, ...plainOpenai } = openaiLarge;
    const { vectorSpace: _b, ...plainAzure } = azureLarge;
    const { vectorSpace: _c, ...plainMistral } = mistralEmbed;
    const router = createRuleRouter({
      targets: [plainOpenai, plainAzure, plainMistral],
      rules: [embedRule(['openai-3-large', 'mistral-embed', 'azure-3-large'])],
    });
    const request: RouteRequest = { purpose: 'embed', affinityKey: 'index-job-1' };
    const plan = router.plan(request);
    expect(plan.vectorSpace).toBe('text-embedding-3-large');
    expect(plan.order).toEqual(['openai-3-large', 'azure-3-large']);
    expect(plan.candidates[1]?.dropped).toBe('different_vector_space');

    await router.run(request, async (target) => {
      if (target.providerId === 'openai') throw fail('TIMEOUT', 'slow');
      return [1];
    });
    const next = router.plan(request);
    expect(next.sticky).toBe(true);
    expect(next.order).toEqual(['azure-3-large', 'openai-3-large']);
    expect(next.vectorSpace).toBe('text-embedding-3-large');
  });
});

// ─── 8 & 9. Live rows and per-tenant data rules ──────────────

describe('rule router — live data', () => {
  it('re-reads targets and rules on every call, so a changed row applies with no restart', async () => {
    let targets: RouteTarget[] = [groq, azure];
    let rules: RouteRule[] = [chatRule(['groq-llama', 'azure-gpt4o'])];
    const router = createRuleRouter({ targets: () => targets, rules: () => rules });

    expect(router.plan(CHAT).chosen).toBe('groq-llama');

    // An administrator switches Groq off.
    targets = [{ ...groq, enabled: false }, azure];
    const afterSwitchOff = router.plan(CHAT);
    expect(afterSwitchOff.chosen).toBe('azure-gpt4o');
    expect(afterSwitchOff.candidates[0]?.dropped).toBe('switched_off');
    const outcome = await router.run(CHAT, async (target) => target.key);
    expect(outcome.value).toBe('azure-gpt4o');

    // ... switches it back on and reorders the route.
    targets = [groq, azure];
    rules = [
      {
        key: 'chat-default',
        purpose: 'chat',
        steps: [
          { targetKey: 'groq-llama', order: 20 },
          { targetKey: 'azure-gpt4o', order: 10 },
        ],
      },
    ];
    expect(router.plan(CHAT).order).toEqual(['azure-gpt4o', 'groq-llama']);

    // ... and finally removes the route.
    rules = [];
    const none = router.plan(CHAT);
    expect(none.ruleKey).toBeUndefined();
    expect(none.explanation).toContain('no routing rule for this purpose');
    expect(router.health().map((h) => h.targetKey)).toEqual(['groq-llama', 'azure-gpt4o']);
  });

  it('applies a different data rule per tenant through the function form', async () => {
    const perTenant = new Map<string, DataRule>([
      ['tenant-eu', { allowedRegions: ['eu'] }],
      ['tenant-us', { allowedProviders: ['groq'] }],
    ]);
    const asked: (string | undefined)[] = [];
    const router = createRuleRouter({
      targets: [groq, azure],
      rules: [chatRule(['groq-llama', 'azure-gpt4o'])],
      dataRule: (request) => {
        asked.push(request.tenantId);
        return request.tenantId === undefined ? undefined : perTenant.get(request.tenantId);
      },
    });

    const eu = router.plan({ purpose: 'chat', tenantId: 'tenant-eu' });
    expect(eu.chosen).toBe('azure-gpt4o');
    expect(eu.candidates[0]).toMatchObject({ targetKey: 'groq-llama', dropped: 'region_not_allowed' });
    expect(eu.explanation).toBe(
      'Sent to Azure gpt-4o: second choice for chat. Skipped Groq llama-3.3-70b (region not allowed for this workspace).',
    );

    const us = router.plan({ purpose: 'chat', tenantId: 'tenant-us' });
    expect(us.order).toEqual(['groq-llama']);
    expect(us.candidates[1]).toMatchObject({ targetKey: 'azure-gpt4o', dropped: 'provider_not_allowed' });

    // A tenant with no rule, and a request with no tenant, are unrestricted.
    expect(router.plan({ purpose: 'chat', tenantId: 'tenant-other' }).order).toEqual(['groq-llama', 'azure-gpt4o']);
    expect(router.plan(CHAT).order).toEqual(['groq-llama', 'azure-gpt4o']);
    expect(asked).toEqual(['tenant-eu', 'tenant-us', 'tenant-other', undefined]);

    // The rule is also applied when running: the EU tenant's request never reaches Groq.
    perTenant.set('tenant-eu', { allowedRegions: ['eu'], allowedProviders: ['azure'] });
    const calls: string[] = [];
    const outcome = await router.run({ purpose: 'chat', tenantId: 'tenant-eu' }, async (target) => {
      calls.push(target.key);
      return 'ok';
    });
    expect(calls).toEqual(['azure-gpt4o']);
    expect(outcome.plan.candidates[0]?.dropped).toBe('provider_not_allowed');
  });
});
