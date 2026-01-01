/**
 * Security middleware for Enhanced Privacy Mode
 * Provides security headers, IP anonymization, and timing obfuscation
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { PrivacyConfig, randomDelay } from '../../prestige/privacy.js';

export interface SecurityConfig {
  /** Enable strict Content Security Policy */
  strictCSP: boolean;
  /** Enable HSTS (HTTP Strict Transport Security) */
  enableHSTS: boolean;
  /** HSTS max age in seconds */
  hstsMaxAge: number;
  /** Strip IP-identifying headers */
  stripIPHeaders: boolean;
  /** Disable request logging */
  disableLogging: boolean;
  /** Onion-Location header for Tor hidden service */
  onionLocation?: string;
}

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  strictCSP: true,
  enableHSTS: true,
  hstsMaxAge: 31536000, // 1 year
  stripIPHeaders: false,
  disableLogging: false,
  onionLocation: undefined,
};

/**
 * Security headers middleware
 * Sets various security headers to protect against common attacks
 */
export function securityHeaders(config: Partial<SecurityConfig> = {}): RequestHandler {
  const cfg = { ...DEFAULT_SECURITY_CONFIG, ...config };

  return (req: Request, res: Response, next: NextFunction) => {
    // Content Security Policy - Tor Browser compatible
    const csp = cfg.strictCSP
      ? [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'", // Allow inline for Tor compatibility
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self'",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; ')
      : "default-src 'self'";

    res.setHeader('Content-Security-Policy', csp);

    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');

    // XSS Protection (legacy, but still useful)
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // Referrer Policy - don't leak URLs
    res.setHeader('Referrer-Policy', 'no-referrer');

    // Permissions Policy - disable unnecessary features
    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()'
    );

    // HSTS - force HTTPS
    if (cfg.enableHSTS) {
      res.setHeader(
        'Strict-Transport-Security',
        `max-age=${cfg.hstsMaxAge}; includeSubDomains`
      );
    }

    // Cross-Origin policies
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    // Onion-Location for Tor hidden service
    if (cfg.onionLocation) {
      res.setHeader('Onion-Location', cfg.onionLocation);
    }

    // Remove server identification
    res.removeHeader('X-Powered-By');

    next();
  };
}

/**
 * IP anonymization middleware
 * Strips headers that could identify the client's IP address
 */
export function ipAnonymization(enabled: boolean = false): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) {
      return next();
    }

    // Headers that may contain IP information
    const ipHeaders = [
      'x-forwarded-for',
      'x-real-ip',
      'x-client-ip',
      'cf-connecting-ip',
      'true-client-ip',
      'x-cluster-client-ip',
      'forwarded',
    ];

    // Remove IP-identifying headers from the request
    for (const header of ipHeaders) {
      delete req.headers[header];
    }

    // Store anonymized marker for downstream code
    (req as any).ipAnonymized = true;

    next();
  };
}

/**
 * Timing obfuscation middleware
 * Adds random delays to responses to prevent timing attacks
 */
export function timingObfuscation(config: PrivacyConfig): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!config.enabled) {
      return next();
    }

    // Add delay before processing
    await randomDelay(config.minDelayMs / 2, config.maxDelayMs / 2);

    // Store original end function
    const originalEnd = res.end.bind(res);
    const originalJson = res.json.bind(res);

    // Wrap response methods to add delay
    res.end = function (this: Response, ...args: Parameters<Response['end']>) {
      // Add delay after processing (async, but we can't await here)
      const delayMs = config.minDelayMs / 2 + Math.random() * (config.maxDelayMs - config.minDelayMs) / 2;
      setTimeout(() => {
        originalEnd(...args);
      }, delayMs);
      return this;
    } as Response['end'];

    res.json = function (this: Response, body: unknown) {
      const delayMs = config.minDelayMs / 2 + Math.random() * (config.maxDelayMs - config.minDelayMs) / 2;
      setTimeout(() => {
        originalJson(body);
      }, delayMs);
      return this;
    };

    next();
  };
}

/**
 * Response time normalization middleware
 * Ensures all responses take at least a minimum time
 */
export function normalizedResponseTime(targetMs: number): RequestHandler {
  if (targetMs <= 0) {
    return (_req, _res, next) => next();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();

    // Store original methods
    const originalEnd = res.end.bind(res);
    const originalJson = res.json.bind(res);

    const waitAndExecute = (fn: (...args: any[]) => any, ...args: any[]) => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, targetMs - elapsed);

      if (remaining > 0) {
        setTimeout(() => fn(...args), remaining);
      } else {
        fn(...args);
      }
    };

    res.end = function (this: Response, ...args: any[]) {
      waitAndExecute(originalEnd, ...args);
      return this;
    } as Response['end'];

    res.json = function (this: Response, body: unknown) {
      waitAndExecute(originalJson, body);
      return this;
    };

    next();
  };
}

/**
 * Privacy-aware request logging
 * Logs requests without sensitive information
 */
export function privacyAwareLogging(disabled: boolean = false): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (disabled) {
      return next();
    }

    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      // Log without IP or user agent
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`
      );
    });

    next();
  };
}

/**
 * Rate limiting with privacy considerations
 * Uses hashed identifiers instead of raw IPs
 */
export function privacyRateLimiter(
  windowMs: number,
  maxRequests: number,
  keyGenerator?: (req: Request) => string
): RequestHandler {
  const requests = new Map<string, { count: number; resetAt: number }>();

  // Default key generator uses a hash of various request properties
  const getKey = keyGenerator || ((req: Request) => {
    // In privacy mode, use a session-based key if available
    // Otherwise, use a very coarse identifier
    const sessionId = req.headers['x-session-id'] as string | undefined;
    if (sessionId) {
      return `session:${sessionId}`;
    }
    // Fall back to user-agent hash (very coarse, shared by many users)
    return `ua:${hashString(req.headers['user-agent'] || 'unknown')}`;
  });

  return (req: Request, res: Response, next: NextFunction) => {
    const key = getKey(req);
    const now = Date.now();

    let entry = requests.get(key);

    // Clean up expired entries periodically
    if (Math.random() < 0.01) {
      for (const [k, v] of requests.entries()) {
        if (v.resetAt < now) {
          requests.delete(k);
        }
      }
    }

    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      requests.set(key, entry);
    }

    entry.count++;

    if (entry.count > maxRequests) {
      res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count).toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000).toString());

    next();
  };
}

/**
 * Simple string hash for rate limiting keys
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Combined privacy middleware stack
 */
export function privacyMiddleware(
  privacyConfig: PrivacyConfig,
  securityConfig: Partial<SecurityConfig> = {}
): RequestHandler[] {
  const middlewares: RequestHandler[] = [
    securityHeaders(securityConfig),
  ];

  if (privacyConfig.enabled) {
    middlewares.push(
      ipAnonymization(true),
      privacyAwareLogging(securityConfig.disableLogging),
    );

    if (privacyConfig.normalizedResponseMs > 0) {
      middlewares.push(normalizedResponseTime(privacyConfig.normalizedResponseMs));
    } else if (privacyConfig.maxDelayMs > 0) {
      middlewares.push(timingObfuscation(privacyConfig));
    }
  }

  return middlewares;
}
