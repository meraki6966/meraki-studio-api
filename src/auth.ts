import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * One shared token guards every route except /health.
 *
 * Why this exists: the server can spend money (video and image generation),
 * speak in Adam's cloned voice (generate_narration) and read and write project
 * files. Until October 2026 it did all of that for any caller who knew the URL.
 *
 * Rules:
 *  - The token comes from STUDIO_API_TOKEN and nowhere else. It is never
 *    accepted in a URL, because URLs end up in logs and browser history.
 *  - If the variable is missing or too short, the server is locked. It does
 *    not fall back to being open.
 *  - A refused request is logged with its address and path. The value that was
 *    presented is never logged.
 */
export const MIN_TOKEN_LENGTH = 32;

export function configuredToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = (env.STUDIO_API_TOKEN || '').trim();
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

/** The token from an "Authorization: Bearer <token>" header, or null. */
export function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+([^\s]+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/** Compared as SHA-256 digests so the check takes the same time whatever was presented. */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function callerAddress(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (first ? first.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

export function requireToken(
  getToken: () => string | null = () => configuredToken(),
  log: (line: string) => void = (line) => console.warn(line),
) {
  return function tokenGate(req: Request, res: Response, next: NextFunction) {
    const expected = getToken();
    if (!expected) {
      log(`[auth] locked: STUDIO_API_TOKEN is not set. ${req.method} ${req.path} from ${callerAddress(req)}`);
      return res.status(503).json({
        error: `Studio is locked. Set STUDIO_API_TOKEN on the server to a random value of ${MIN_TOKEN_LENGTH} characters or more.`,
      });
    }
    const presented = bearerToken(req.headers.authorization);
    if (!presented || !tokensMatch(presented, expected)) {
      log(`[auth] refused: ${presented ? 'wrong token' : 'no token'}. ${req.method} ${req.path} from ${callerAddress(req)}`);
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'A valid Authorization: Bearer token is required.' });
    }
    next();
  };
}
