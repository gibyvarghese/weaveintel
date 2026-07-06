---
"@weaveintel/skills": patch
---

Skill packages (Phase 2) — runtime least-privilege enforcement + package↔definition linkage.

Closes real gaps in the Level-3 execution path (the parser and install-time security gates were solid,
but the *runner* didn't self-enforce the manifest):

- **`runSkillScript` now honours the least-privilege manifest at run time** (defense in depth — safe even
  if the app never ran the install-time gates): a package that declares `execution: false` is refused
  before any sandbox is started, and it no longer advertises a `run_skill_script` tool.
- **Network is manifest-authoritative.** Egress is decided by the package's declared `network:` host
  allowlist — not a fragile "does an allowed-tool name contain 'web'?" heuristic — and those exact hosts
  are passed to the runner via a new `SkillScriptRunSpec.networkAllowlist`, so a proxy-capable sandbox can
  restrict egress to just them (the NVIDIA/OWASP egress model). No declared hosts ⇒ no network, even when
  the caller opts in. (Grounded in the 2026 SkillGuard / skillsandbox / OWASP Agentic Skills work.)
- **Package↔definition link.** A bridged skill now carries a lightweight `SkillDefinition.package` pointer
  (its manifest + bundled file names), and a new `createSkillPackageIndex(packages)` / `SkillPackageIndex`
  turns an activated skill back into its Level-3 tools (`toolsFor` — returns `[]` for non-package skills).
  This closes the retrieve → activate → open/run-files loop that was previously unreachable. Also exports
  `skillPackageRef` and the `SkillPackageRef` type.

Additive and backward-compatible (new optional fields, stricter fail-closed network default). Tested:
new 4-tier hermetic linkage + enforcement suites, updated network/execution tests, and real Docker +
real-OpenAI e2e (execution:false refused before the container starts; retrieve → activate → index →
run-in-container flagship).
