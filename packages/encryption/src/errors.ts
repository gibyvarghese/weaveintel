/**
 * @weaveintel/encryption — error types
 */

export class EncryptionError extends Error {
  override readonly name: string = 'EncryptionError';
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

export class KeyNotFoundError extends EncryptionError {
  override readonly name = 'KeyNotFoundError';
  constructor(message: string) {
    super(message);
  }
}

export class AeadError extends EncryptionError {
  override readonly name = 'AeadError';
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class KmsUnavailableError extends EncryptionError {
  override readonly name = 'KmsUnavailableError';
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class CiphertextFormatError extends EncryptionError {
  override readonly name = 'CiphertextFormatError';
  constructor(message: string) {
    super(message);
  }
}
