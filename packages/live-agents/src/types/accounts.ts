export interface McpServerRef {
  url: string;
  serverType: 'STDIO' | 'HTTP' | 'WEBSOCKET';
  discoveryHint: string | null;
}

export interface Account {
  id: string;
  meshId: string;
  provider: string;
  accountIdentifier: string;
  description: string;
  mcpServerRef: McpServerRef;
  credentialVaultRef: string;
  upstreamScopesDescription: string;
  ownerHumanId: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  revokedAt: string | null;
}

export interface AccountBinding {
  id: string;
  agentId: string;
  accountId: string;
  purpose: string;
  constraints: string;
  grantedByHumanId: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByHumanId: string | null;
  revocationReason: string | null;
}

export interface AccountBindingRequest {
  id: string;
  meshId: string;
  agentId: string;
  accountId: string | null;
  requestedByType: 'AGENT' | 'HUMAN';
  requestedById: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  resolvedByHumanId: string | null;
  resolvedAccountBindingId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
  purposeProse: string;
  reasonProse: string;
  resolutionReasonProse: string | null;
  evidenceRefs: string[];
}
