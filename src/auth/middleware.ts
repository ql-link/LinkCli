import type { NextFunction, Request, Response } from "express";
import type { PlatformSession, PlatformUser, UserRole } from "../domain.js";
import { AppError } from "../errors.js";
import type { IdentityService } from "./service.js";

export const SESSION_COOKIE = "linkcli_session";

declare global { namespace Express { interface Request { consoleUser?: PlatformUser; consoleSession?: PlatformSession; sessionToken?: string; } } }

export function parseCookies(header: string | undefined): Record<string,string> {
  if (!header) return {};
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter((pair) => pair.length === 2).map(([key,value]) => [decodeURIComponent(key!),decodeURIComponent(value!)]));
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", expires: expiresAt });
}
export function clearSessionCookie(res: Response, secure: boolean): void { res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure, path: "/" }); }

export function requireSession(identity: IdentityService, secure: boolean) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = parseCookies(req.header("cookie"))[SESSION_COOKIE];
      if (!token) throw new AppError("AUTHENTICATION_REQUIRED", "Login is required", 401);
      const authenticated = await identity.authenticate(token);
      req.consoleUser = authenticated.user; req.consoleSession = authenticated.session; req.sessionToken = token;
      if (authenticated.renewed) setSessionCookie(res, token, authenticated.session.expiresAt, secure);
      next();
    } catch (error) { next(error); }
  };
}

export const requireConsoleRole = (roles: UserRole[]) => (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.consoleUser || !roles.includes(req.consoleUser.role)) return next(new AppError("AUTHORIZATION_FAILED", "Your role is not allowed to perform this action", 403));
  next();
};

export function requireSameOrigin(req: Request, _res: Response, next: NextFunction): void {
  if (["GET","HEAD","OPTIONS"].includes(req.method)) return next();
  const origin = req.header("origin");
  if (!origin) return next();
  try { if (new URL(origin).host !== req.header("host")) throw new Error("mismatch"); } catch { return next(new AppError("INVALID_ORIGIN", "Cross-origin write requests are not allowed", 403)); }
  next();
}
