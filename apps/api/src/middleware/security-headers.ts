import type { Request, RequestHandler, Response } from 'express';
import type { Env } from '../config/env.js';

/**
 * Module 14: security response headers and HTTPS enforcement.
 *
 * The API only ever returns JSON and streamed storage objects, so the policy
 * can be maximally strict (`default-src 'none'`): it is never the document that
 * renders the SPA. The Vite/SPA build gets its own, looser CSP documented in
 * docs/SECURITY.md because it must load hashed JS/CSS assets.
 */

const API_CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src 'self'",
  "style-src 'unsafe-inline'", // storage previews may inline styles in PDF viewers
  "sandbox",
].join('; ');

export function securityHeaders(env: Env): RequestHandler {
  return (req: Request, res: Response, next): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', API_CSP);
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    // HSTS only on connections that actually arrived over HTTPS: sending it
    // from a plain-HTTP local run would poison the browser for localhost.
    if (env.nodeEnv === 'production' && req.secure) {
      res.setHeader(
        'Strict-Transport-Security',
        `max-age=${Math.max(0, Math.floor(env.hstsMaxAgeSeconds))}; includeSubDomains`,
      );
    }
    next();
  };
}

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/i;

/**
 * Redirects plain HTTP to HTTPS in production. `req.secure` honours
 * `X-Forwarded-Proto` only when `trust proxy` is configured, so a direct
 * attacker cannot spoof it. The redirect is skipped when the Host header is not
 * a plain hostname, which prevents open-redirect and header-injection abuse.
 */
export function requireHttps(env: Env): RequestHandler {
  return (req: Request, res: Response, next): void => {
    if (!env.requireHttps || req.secure) {
      next();
      return;
    }
    // Health checks may come from a plain-HTTP load balancer probe.
    if (req.path === '/health') {
      next();
      return;
    }
    const host = req.headers.host;
    if (!host || !HOSTNAME.test(host)) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'HTTPS is required', requestId: req.requestId },
      });
      return;
    }
    res.redirect(308, `https://${host}${req.originalUrl}`);
  };
}
