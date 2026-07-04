# @weaveintel/prompts

**Versioned prompt templates with safe variable substitution, reusable fragments, output contracts, and A/B experiments.**

## Why it exists

A prompt is really a document that many people edit and ship to production — and like any shipped document, an unreviewed change can quietly break things downstream. Think of it like a recipe card kept in a binder: each card has a version, blanks you fill in ("2 cups of {{flour}}"), and shared notes you paste in from other cards. `prompts` gives you that binder — templates you can fill in without accidentally leaving a blank, older versions you can roll back to, and checks that the finished dish matches the order before it leaves the kitchen.

## When to reach for it

Reach for it when prompts are first-class assets: you need to substitute variables safely, lint a template before rendering, compose named sections (RTCE, critique, judge), enforce an output contract, or run an A/B experiment between prompt versions. If you just need a one-off string, plain template literals are fine — you don't need this. If you want the *type* definitions for prompt records rather than the engine, those live in `@weaveintel/core`.

## How to use it

```ts
import { createSafeTemplate, extractVariables } from '@weaveintel/prompts';

const tmpl = createSafeTemplate('Summarize {{topic}} for a {{audience}} reader.');

console.log(extractVariables(tmpl)); // ['topic', 'audience']

const rendered = tmpl.render({ topic: 'tax law', audience: 'lay' });
console.log(rendered); // "Summarize tax law for a lay reader."
```

## What's in the box

- **Templates** — `createTemplate`, `createSafeTemplate`, `extractVariables`, `renderWithOptions`, `renderStructuredPromptMessages`.
- **Registry & resolution** — `InMemoryPromptRegistry`, `PromptResolver`, `resolvePromptRecordForExecution`.
- **Composition** — `frameworks` (`FRAMEWORK_RTCE`, `FRAMEWORK_JUDGE`, `renderFramework`) and `fragments` (`resolveFragments`, `{{>key}}` includes).
- **Quality gates** — `lintPromptTemplate`, `validateContract` (JSON/markdown/code/length contracts).
- **Experiments** — `InMemoryExperimentStore`, `weightedSelect`.
- **Provider adapters** — `openAIAdapter`, `anthropicAdapter`, `resolveAdapter`.
- **Evaluation & optimization** — `evaluatePromptDatasetForRecord`, `runPromptOptimization`.
- **Translation** — `buildTranslatePrompt`, `protectNonTranslatable`, `verifyTranslation`.

Single entry point: `@weaveintel/prompts`.

## License

MIT.
