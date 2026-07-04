# @weaveintel/skills

**Reusable capability bundles an agent discovers and applies on its own — each skill describes when, why, and how to do one kind of task.**

## Why it exists

A capable assistant knows more than facts — they know *procedures*: "when someone asks for a refund, here's how we handle it; here's what 'done' looks like; here's what not to touch." You don't want to re-explain that procedure in every prompt, and you don't want a brittle keyword rule that fires on the wrong request. A skill is that written-down procedure, phrased so the model can recognise when it applies. Think of an onboarding binder full of "how we do X here" cards: the agent flips to the right card when the situation matches, follows it, and checks the result against the card's definition of done. This package is that binder — text-first, semantic (not keyword), with governance and completion contracts baked in.

## When to reach for it

Reach for `@weaveintel/skills` when you have recurring task-shapes you want an agent to recognise and handle consistently — with guidance on execution, output, and what counts as complete. If you instead need concrete callable functions (search, send email, run SQL), those are tools from `@weaveintel/tools`, not skills. A skill often *points at* tools, but it is guidance, not code.

## How to use it

```ts
import { createSkillRegistry, BUILT_IN_SKILLS, applySkillsToPrompt } from '@weaveintel/skills';

const registry = createSkillRegistry();
for (const skill of BUILT_IN_SKILLS) registry.register(skill);

// Match the user's request against registered skills.
const result = await registry.activate('summarise this contract and flag risky clauses');

// Fold the activated skill guidance into the system prompt before the model runs.
const systemPrompt = applySkillsToPrompt('You are a helpful assistant.', result);
```

## What's in the box

| Export | What it does |
|---|---|
| `createSkillRegistry` | A registry to `register`, `discover`, `list`, and `activate` skills. |
| `SkillDefinition` (type) | The shape of a skill — `summary`, `whenToUse`, `whenNotToUse`, execution/output/completion guidance, policy, examples. |
| `BUILT_IN_SKILLS` | Ready-made skills you can register as-is. |
| `activateSkills` | Match a query against a set of skills and return the activated set. |
| `evaluateSkillCompletion` | Check a run's result against a skill's completion contract. |
| `collectSkillTools` | Gather the tools a skill's guidance references. |
| `createSkillTelemetry` | Record which skills fired and how they performed. |
| `buildSkillInvocationPrompt`, `buildSkillSystemPrompt`, `applySkillsToPrompt` | Turn skill guidance into prompt text. |
| `A2A_SKILL_CATALOG`, `SUPERVISOR_V2_WORKERS`, `mapA2ASkillToRow` | The A2A skill taxonomy and DB-seed helpers. |
| `mapSkillToRow` | Seed a skill into a database row. |

## License

MIT.
