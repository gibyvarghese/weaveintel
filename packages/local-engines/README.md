# @weaveintel/local-engines

**Run short AI tasks on the person's own device (a browser's built-in model, later small in-browser models) behind a
chain that a server issued, checked step by step, and always ending at a hosted model.**

## Why it exists

Some tasks are small enough to run on the device: detect a message's language, summarise one record for the person
reading it, suggest a category from a fixed list. Doing that locally saves tokens and keeps text on the device. But a
device is untrusted compute: the server must decide what may run where, and whatever the device answers is only a
suggestion. This package is the device half of that arrangement:

- **The engine contract** (`LocalEngine`): `supports`, `availability` (never downloads), `run`.
- **Routing tickets**: canonical hashes over the field list and the chain (`hashFieldList`, `hashChain`,
  `sealTicket`), shared by the server that issues a ticket and the device that walks it; `verifyTicket` refuses a
  ticket that was altered, expired, has no hosted end, lists an engine the shell may never use, or fails its signature.
- **The chain walker** (`walkChain`): tries each local step in order and records one reason per step that did not
  answer (`unavailable`, `download_refused`, `over_budget`, `out_of_memory`, `timeout`, `schema_violation`,
  `low_confidence`, `device_policy_blocked`, `offline`, `not_applicable`). It never runs a hosted step: it hands the
  hosted end back to the caller, who makes the normal hosted call carrying the ticket id.
- **A capability probe** (`probeCapabilities`, `readDeviceState`): presence of features only, never a model call.
- **Output checks per task** (`validateTaskOutput`) and **pinned-file checks** (`verifyFileBytes`).
- **Engines**: `createStubEngine` (deterministic, for tests and demos) and `createChromeBuiltinEngine` (Chrome's
  Language Detector, Summarizer, Translator and Prompt API; feature-detected).

Browser-safe: no Node built-ins, no dependencies, only WebCrypto and standard globals.

## When to reach for it

When a server you control decides, per tenant and task, whether a device may try a local model first, and you want
the device side to be small, testable and unable to widen what the server allowed. If you only ever call hosted
models, you do not need it.

## How to use it

```ts
import {
  createChromeBuiltinEngine,
  probeCapabilities,
  readDeviceState,
  toHostedFallback,
  toResultSubmission,
  walkChain,
} from '@weaveintel/local-engines';

const capabilities = probeCapabilities();             // send with the routing request (a hint, no content)
const ticket = await askServerForTicket(capabilities); // your API: the server seals and signs the ticket

const result = await walkChain({
  ticket,
  engines: [createChromeBuiltinEngine()],
  input: { text: description },
  device: await readDeviceState(),
  policy: tenantDevicePolicy,                          // from your server; default allows no downloads
  confirmDownload: askThePerson,                       // absent: every download is refused
});

if (result.kind === 'local') await postSuggestion(toResultSubmission(result));
else if (result.kind === 'hosted') await callHosted(toHostedFallback(result));
```

On the server, build the ticket with `sealTicket(body)`, sign `ticketSigningPayload(sealed)` with your key, store the
two hashes, and check them again (with `hashChain` / `hashFieldList`) when a result comes back. Use `checkChain` when
an administrator saves a chain.

## Rules it keeps

- `availability()` never downloads. Chrome's `create()` (which can start a multi-gigabyte model download) is called
  only when the browser says the model is available, or when the walker's download gate passed: policy budget, the
  step's limit, an unmetered connection when required, and the person's yes.
- A chain must end at a hosted step unless the server sealed it local only.
- A web page never walks a `local-server` or operating-system engine step.
- Only the fields the ticket lists reach an engine. Output is checked per task; confidence below the step's floor
  falls through.
- Provenance (`observedVersion`, `weightsSha256`) is recorded with `attested: false`. Nothing should trust it.

## Not in this version

In-browser encoders and small LLMs (`browser-wasm`, `browser-webgpu`), Edge's Prompt API, desktop and mobile bridges
(`os-*`, `local-server`): the contract covers them; their adapters need downloads and are not built.
