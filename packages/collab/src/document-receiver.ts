// SPDX-License-Identifier: MIT

/** Identifies one document in one collaboration session and tenant. */
export interface CollaborationDocumentScope {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly documentId: string;
  /** Identifies the operation format, including its version. */
  readonly documentKind: string;
}

/** An untrusted delivery. The host supplies the authenticated principal separately. */
export interface CollaborationDelivery<Op = unknown> {
  readonly scope: CollaborationDocumentScope;
  readonly operations: readonly Op[];
}

export type CollaborationReceiveResult = 'accepted' | 'invalid' | 'scope-mismatch' | 'unauthorized';

/**
 * Host-provided boundary around a single document replica. Callbacks are synchronous:
 * authorization is checked on every delivery, not cached across reconnects.
 */
export interface CollaborationReceiverOptions<Op, Principal> {
  readonly scope: CollaborationDocumentScope;
  readonly maxOperations: number;
  /** Check current session membership, document access and write permission. */
  authorize(principal: Principal, scope: CollaborationDocumentScope): boolean;
  /** Validate the entire batch, including author ownership using the verified principal. */
  validate(operations: readonly unknown[], principal: Principal): { ok: boolean; ops?: Op[] };
  /** Delegate merging, duplicate handling and causal buffering to the document adapter. */
  apply(operations: Op[]): void;
}

export interface CollaborationReceiver<Principal> {
  receive(principal: Principal, delivery: unknown): CollaborationReceiveResult;
}

/**
 * Routes validated operations to exactly one replica. This is not a transport,
 * identity provider, persistence layer, or CRDT. The host must authenticate the
 * principal before calling receive and must never obtain it from the delivery.
 */
export function createCollaborationReceiver<Op, Principal>(
  options: CollaborationReceiverOptions<Op, Principal>,
): CollaborationReceiver<Principal> {
  const { tenantId, sessionId, documentId, documentKind } = options.scope;
  if ([tenantId, sessionId, documentId, documentKind].some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('Collaboration scope requires non-empty identifiers');
  }
  if (!Number.isSafeInteger(options.maxOperations) || options.maxOperations < 1) {
    throw new Error('maxOperations must be a positive safe integer');
  }
  const scope = Object.freeze({ tenantId, sessionId, documentId, documentKind });
  const { authorize, validate, apply, maxOperations } = options;

  return {
    receive(principal, delivery) {
      if (typeof delivery !== 'object' || delivery === null || Array.isArray(delivery)) return 'invalid';
      const message = delivery as Record<string, unknown>;
      const inputScope = message['scope'];
      if (typeof inputScope !== 'object' || inputScope === null || Array.isArray(inputScope)) return 'invalid';
      const candidate = inputScope as Record<string, unknown>;
      if (candidate['tenantId'] !== scope.tenantId || candidate['sessionId'] !== scope.sessionId
        || candidate['documentId'] !== scope.documentId || candidate['documentKind'] !== scope.documentKind) {
        return 'scope-mismatch';
      }
      if (authorize(principal, scope) !== true) return 'unauthorized';
      const raw = message['operations'];
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > maxOperations) return 'invalid';
      const result = validate(raw.slice(), principal);
      if (result?.ok !== true || !Array.isArray(result.ops) || result.ops.length !== raw.length) return 'invalid';
      apply(result.ops);
      return 'accepted';
    },
  };
}
