export class LiveAgentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveAgentsError';
  }
}

export class NotImplementedLiveAgentsError extends LiveAgentsError {
  constructor(feature: string) {
    super(`${feature} is not implemented in Phase 1 scaffold.`);
    this.name = 'NotImplementedLiveAgentsError';
  }
}

export class OnlyHumansMayBindAccountsError extends LiveAgentsError {
  constructor(grantedByHumanId: string) {
    super(`Account bindings must be granted by a human principal. Received: ${grantedByHumanId}`);
    this.name = 'OnlyHumansMayBindAccountsError';
  }
}

export class InvalidAccountBindingError extends LiveAgentsError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAccountBindingError';
  }
}

export class NoAuthorisedAccountError extends LiveAgentsError {
  constructor(agentId: string, purpose: string) {
    super(`No authorised account is available for agent ${agentId} to ${purpose}.`);
    this.name = 'NoAuthorisedAccountError';
  }
}

export class SelfGrantForbiddenError extends LiveAgentsError {
  constructor(issuerId: string) {
    super(`Self-grants are forbidden for issuer ${issuerId} unless trigger is BREAK_GLASS.`);
    this.name = 'SelfGrantForbiddenError';
  }
}

export class GrantAuthorityViolationError extends LiveAgentsError {
  constructor(message: string) {
    super(message);
    this.name = 'GrantAuthorityViolationError';
  }
}

export class BreakGlassPolicyViolationError extends LiveAgentsError {
  constructor(message: string) {
    super(message);
    this.name = 'BreakGlassPolicyViolationError';
  }
}

export class SelfPromotionForbiddenError extends LiveAgentsError {
  constructor(issuerId: string) {
    super(`Self-promotion is forbidden for issuer ${issuerId}.`);
    this.name = 'SelfPromotionForbiddenError';
  }
}

export class ContractAuthorityViolationError extends LiveAgentsError {
  constructor(message: string) {
    super(message);
    this.name = 'ContractAuthorityViolationError';
  }
}

export class CrossMeshBridgeRequiredError extends LiveAgentsError {
  constructor(fromMeshId: string, toMeshId: string, reason?: string) {
    super(`Cross-mesh message is not authorised from ${fromMeshId} to ${toMeshId}.${reason ? ` ${reason}` : ''}`);
    this.name = 'CrossMeshBridgeRequiredError';
  }
}
