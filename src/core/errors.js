/** Exit codes are part of the public CLI contract (docs/specs/cli.md). */
export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  VERIFICATION_FAILED: 3,
  APPROVAL_DENIED: 4,
  DAEMON_UNAVAILABLE: 5,
});

export class TorisError extends Error {
  /** @param {string} message @param {string} code @param {number} exitCode */
  constructor(message, code = 'E_TORIS', exitCode = EXIT.FAILURE) {
    super(message);
    this.name = 'TorisError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class UsageError extends TorisError {
  constructor(message) {
    super(message, 'E_USAGE', EXIT.USAGE);
    this.name = 'UsageError';
  }
}

export class VerificationError extends TorisError {
  constructor(message, failures = []) {
    super(message, 'E_VERIFICATION', EXIT.VERIFICATION_FAILED);
    this.name = 'VerificationError';
    this.failures = failures;
  }
}

export class ApprovalDeniedError extends TorisError {
  constructor(message) {
    super(message, 'E_APPROVAL_DENIED', EXIT.APPROVAL_DENIED);
    this.name = 'ApprovalDeniedError';
  }
}

export class ProviderError extends TorisError {
  constructor(message, provider) {
    super(message, 'E_PROVIDER', EXIT.FAILURE);
    this.name = 'ProviderError';
    this.provider = provider;
  }
}
