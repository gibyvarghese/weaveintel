# ADR 003: Cross-Mesh Bridge Authorization

**Date:** 2024-01  
**Status:** Accepted  
**Deciders:** Architecture team  

## Context

Agents need to collaborate across meshes. Example: Research mesh discovers finding → Compliance mesh reviews → Legal mesh approves.

Two models:

1. **Direct messaging:** Research agent directly sends message to Compliance agent.
   - Problem: No authorization control. Research agent can spam Compliance inbox.

2. **Bridge:** Research mesh registers a bridge. Framework filters and routes messages to Compliance mesh.
   - Benefit: Mesh-level authorization. Compliance mesh can refuse connections.

We chose **bridge**.

## Decision

**Bridge** is a directed, authorized connection between two meshes:

```typescript
interface Bridge {
  id: string;
  sourceMeshId: string;
  targetMeshId: string;
  sourceAgentId?: string;      // optional: only this agent can send
  targetAgentId?: string;       // optional: only receive to this agent
  messageFilter: (msg) => bool; // Filter messages to route
  authorized: boolean;          // Must both meshes approve?
}

// Register bridge: Research mesh → Compliance mesh
const bridge = new Bridge({
  sourceMeshId: researchMesh.id,
  targetMeshId: complianceMesh.id,
  messageFilter: (msg) => msg.type === 'RESEARCH_FINDING',
  authorized: false, // Pending compliance approval
});

await researchMesh.registerBridge(bridge);

// Compliance mesh opts-in
await complianceMesh.approveBridge(bridge.id);

// Now: When research agent sends RESEARCH_FINDING contract
// Framework routes message to compliance mesh inbox
```

### Routing behavior

```typescript
// Research agent: Save contract
await researcher.execAction(finding, 'SAVE_CONTRACT');

// Framework check:
// 1. Contract type is RESEARCH_FINDING
// 2. Is there a bridge from researchMesh to another mesh?
// 3. messageFilter(contract) === true?
// 4. Is bridge authorized by both meshes?
// 5. If yes: Route to compliance mesh
//    If no: Only store locally in research mesh

// Compliance agent: Check inbox
const messages = await complianceMesh.getInbox();
// Result: [research finding message]
```

---

## Authorization model

### Three states

```typescript
enum BridgeAuthStatus {
  'PROPOSED',    // Source mesh created, target mesh not yet aware
  'APPROVED',    // Both meshes approved
  'REVOKED',     // Target mesh revoked approval
}
```

### Workflow

```
1. Research mesh creates bridge (PROPOSED)
   bridge.status = 'PROPOSED'
   bridge.proposedBy = 'research-mesh-admin'
   bridge.proposedAt = now

2. Compliance mesh reviews and approves
   await complianceMesh.approveBridge(bridge.id)
   bridge.status = 'APPROVED'
   bridge.approvedBy = 'compliance-mesh-admin'
   bridge.approvedAt = now

3. Messages start routing (PROPOSED → APPROVED)
   When research agent saves contract → Routed to compliance mesh inbox

4. Later: Compliance mesh revokes (spam, misconfiguration)
   await complianceMesh.revokeBridge(bridge.id)
   bridge.status = 'REVOKED'
   bridge.revokedBy = 'compliance-mesh-admin'
   bridge.revokedAt = now

5. Messages stop routing (APPROVED → REVOKED)
   Research agent saves contract → NOT routed (stays in research mesh)
```

---

## Why this design?

**Question:** Why require both meshes to approve?  
**Answer:** Prevents spam. Compliance mesh can refuse unwanted incoming messages.

**Question:** Why messageFilter?  
**Answer:** Selective routing. Research mesh might generate multiple contract types; only RESEARCH_FINDING crosses the bridge.

**Question:** What if bridge is not authorized yet?  
**Answer:** Messages still create Contracts locally. They're just not routed. When bridge is approved, future messages route. Past messages don't retroactively route.

---

## Examples

### Safe: Research → Compliance approval workflow

```typescript
// Step 1: Research creates bridge to compliance
const bridge = new Bridge({
  sourceMeshId: research.id,
  targetMeshId: compliance.id,
  sourceAgentId: researcher.id,      // Only researcher can send
  targetAgentId: complianceReviewer.id, // Only reviewer receives
  messageFilter: (msg) => msg.type === 'RESEARCH_FINDING',
});
await research.registerBridge(bridge);

// Step 2: Compliance approves
await compliance.approveBridge(bridge.id);

// Step 3: Researcher publishes finding
const finding = new Contract({
  type: 'RESEARCH_FINDING',
  statement: 'Variant XYZ is 40% more transmissible',
  evidence: [...],
});
await researcher.execAction(finding, 'SAVE_CONTRACT');
// → Framework routes to compliance inbox (because bridge is APPROVED)

// Step 4: Reviewer reads inbox, sees finding, approves or requests changes
const messages = await compliance.getInbox();
// [{ from: researcher.id, contract: finding }]

// Step 5: If changes needed, reviewer sends message back (separate bridge)
```

### Unsafe: Direct agent messaging (prevented)

```typescript
// ❌ NOT ALLOWED (framework doesn't expose direct messaging)
await researcher.sendMessage({
  to: complianceReviewer.id,
  text: 'Please review this finding',
});
// Error: sendMessage() is not available.
// Use contracts + bridges instead.
```

### Safe: Revoking spam bridge

```typescript
// Compliance mesh is getting spammed with low-quality findings
await compliance.revokeBridge(bridge.id);
// bridge.status = 'REVOKED'

// Future research findings no longer route
// (existing findings stay in research mesh, not deleted)
```

---

## Scaling

### 100 meshes, 10 agents per mesh

- Each mesh can register multiple outgoing bridges: research → [compliance, legal, audit]
- Total bridges: O(meshes × outgoing connections) = manageable
- Message routing: O(bridges) per contract save (check each bridge's filter)

**Optimization:** Index bridges by source mesh + contract type for fast filter lookups.

---

## Alternatives considered

### 1. Pull-based (target mesh polls)
Compliance mesh periodically queries research mesh for new findings.

**Rejected:** Latency. Compliance wants to react immediately to findings, not poll.

### 2. Topic-based (publish/subscribe)
Agents publish to topics; any mesh can subscribe.

**Rejected:** Harder to revoke (who is listening?). Bridges are simpler (direct connections).

### 3. Global message queue
All contracts go to Kafka topic; routers decide destination.

**Rejected:** Over-engineered for typical use case (2-3 meshes). Bridges are sufficient.

## Consequences

**Positive:**
- Meshes retain autonomy (can revoke bridges)
- Authorization is explicit (both meshes must approve)
- Selective routing (messageFilter prevents spam)

**Negative:**
- Requires bridge setup (extra operational step)
- Async (message routing introduces latency)
- No guarantee of delivery (if target mesh is offline, message sits in source)

---

## Related

- [Use Cases](./use-cases.md) — Example `54-live-agents-cross-mesh-bridges.ts`
- [Account Model](./account-model.md) — Cross-mesh credential scoping
- [@weaveintel/live-agents](../packages/live-agents/README.md) — `Bridge` API
