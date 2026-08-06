export type ErrorCode =
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_FAILED"
  | "CONFLICT"
  | "DOWNSTREAM_AUTH_FAILED"
  | "DOWNSTREAM_CONNECTION_FAILED"
  | "DOWNSTREAM_PROTOCOL_ERROR"
  | "DOWNSTREAM_TIMEOUT"
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "NOT_FOUND"
  | "SERVICE_UNAVAILABLE"
  | "TOOL_VERSION_STALE";

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
