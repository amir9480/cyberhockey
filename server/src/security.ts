import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * Security headers for every response. Other sites may embed the game in an iframe: they still can't read anything
 * inside it (the same-origin policy keeps its DOM and storage from them, and the guest token lives in localStorage,
 * which browsers partition per embedding site; there are no cookies).
 */
export function securityHeaders(appUrl: string): RequestHandler[] {
  const secure = new URL(appUrl).protocol === 'https:';
  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          // Alpine evaluates its x- expressions with `new Function`.
          scriptSrc: ["'self'", "'unsafe-eval'"],
          // Alpine's :style bindings write style attributes.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          // Older Safari doesn't count ws(s) to this host as 'self'.
          connectSrc: ["'self'", 'ws:', 'wss:'],
          // The game-loop ticker runs in a blob: worker.
          workerSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          // Any site may embed the game.
          frameAncestors: ['*'],
          ...(secure && { upgradeInsecureRequests: [] }),
        },
      },
      // Framing is allowed (CSP frame-ancestors above), so no X-Frame-Options.
      xFrameOptions: false,
      // Public content: pages that isolate themselves (COEP) can still embed the game and its images.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      // Only over HTTPS: on plain http (dev, LAN) it would be ignored anyway.
      strictTransportSecurity: secure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
    (_req, res, next) => {
      // Nothing here needs these; fullscreen is for the game itself (an embedder grants it with allow="fullscreen").
      res.set(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=(), fullscreen=(self)',
      );
      next();
    },
  ];
}

/**
 * Whether a websocket upgrade may proceed: browsers always send Origin, so only pages served from this site (APP_URL,
 * or the host the request was made to, which covers LAN and localhost use) get to open the game socket. No Origin
 * means not a browser; the per-address limit covers those.
 */
export function originAllowed(req: IncomingMessage, appOrigin: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === appOrigin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
