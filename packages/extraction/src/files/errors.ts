// SPDX-License-Identifier: MIT
import { WeaveIntelError } from '@weaveintel/core';

/**
 * A file was refused by a limit or because it is malformed: too large, too
 * many entries, a zip bomb, encrypted, a DOCTYPE in XML. `reason` is a stable
 * machine code; the message is one plain sentence. Never retryable.
 */
export class FileLimitError extends WeaveIntelError {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super({ code: 'INVALID_INPUT', message, retryable: false, details: { reason } });
    this.name = 'FileLimitError';
    this.reason = reason;
  }
}
