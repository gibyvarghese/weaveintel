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
