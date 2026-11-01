# @weaveintel/tools

## 0.2.0

### Breaking (fail-closed defaults)

- A tool that declares no `riskLevel` is refused instead of running as `read-only`, and
  `createPolicyEnforcedRegistry` refuses to build (`ToolPolicyConfigError`) when any tool is unlabelled
  (GAPS G-WI-8, platform-architecture §7.4 item 1).
- A call that requires approval — by the policy row **or** the tool's own `schema.requiresApproval` — is
  refused when no `approvalGate` is wired, and the registry refuses to build with such a tool and no
  gate (G-WI-9, §7.4 item 2).
- Built-in MCP connector servers use `callerAssertedMCPContext` (stdio only) instead of reading the
  caller's params themselves (G-WI-10).

### Added

- `assertToolRiskLevels(registryOrTools)` for host start-up checks; `ToolPolicyConfigError`.
- The built-in `time`, `statsnz` and `search` tools are labelled `read-only`.

### Fixed

- Test fixtures broken by the DNS-pinning hardened fetch (core 0.1.2) and a date-bound fixture range.
