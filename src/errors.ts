export type ErrorCode =
  | "AUTHENTICATION_FAILED"
  | "AUTHENTICATION_REQUIRED"
  | "AUTHORIZATION_FAILED"
  | "CONFLICT"
  | "DOWNSTREAM_AUTH_FAILED"
  | "DOWNSTREAM_CONNECTION_FAILED"
  | "DOWNSTREAM_PROTOCOL_ERROR"
  | "DOWNSTREAM_TIMEOUT"
  | "INVALID_INPUT"
  | "INVALID_ORIGIN"
  | "INVALID_STATE"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "TOOL_VERSION_STALE"
  | "USERNAME_TAKEN";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const assertFound = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined) {
    throw new AppError("NOT_FOUND", message, 404);
  }
  return value;
};
