import { createHash } from 'node:crypto';

import { InvalidArgsError } from './errors';
import type { LimitsRedis } from '../redis';

const SLIDING_WINDOW_LIMIT_SCRIPT_SRC = `
  local currentKey  = KEYS[1]           -- identifier including prefixes
  local previousKey = KEYS[2]           -- key of the previous bucket
  local dynamicLimitKey = KEYS[3]       -- optional: key for dynamic limit in redis
  local tokens      = tonumber(ARGV[1]) -- default tokens per window
  local now         = ARGV[2]           -- current timestamp in milliseconds
  local window      = ARGV[3]           -- interval in milliseconds
  local incrementBy = tonumber(ARGV[4]) -- increment rate per request at a given value, default is 1

  -- Check for dynamic limit
  local effectiveLimit = tokens
  if dynamicLimitKey ~= "" then
    local dynamicLimit = redis.call("GET", dynamicLimitKey)
    if dynamicLimit then
      effectiveLimit = tonumber(dynamicLimit)
    end
  end

  local requestsInCurrentWindow = redis.call("GET", currentKey)
  if requestsInCurrentWindow == false then
    requestsInCurrentWindow = 0
  end

  local requestsInPreviousWindow = redis.call("GET", previousKey)
  if requestsInPreviousWindow == false then
    requestsInPreviousWindow = 0
  end
  local percentageInCurrent = ( now % window ) / window
  -- weighted requests to consider from the previous window
  requestsInPreviousWindow = math.floor(( 1 - percentageInCurrent ) * requestsInPreviousWindow)

  -- Only check limit if not refunding (negative rate)
  if incrementBy > 0 and requestsInPreviousWindow + requestsInCurrentWindow >= effectiveLimit then
    return {-1, effectiveLimit}
  end

  local newValue = redis.call("INCRBY", currentKey, incrementBy)
  if newValue == incrementBy then
    -- The first time this key is set, the value will be equal to incrementBy.
    -- So we only need the expire command once
    redis.call("PEXPIRE", currentKey, window * 2 + 1000) -- Enough time to overlap with a new window + 1 second
  end
  return {effectiveLimit - ( newValue + requestsInPreviousWindow ), effectiveLimit}
`;

export const SLIDING_WINDOW_LIMIT_SCRIPT = {
    script: SLIDING_WINDOW_LIMIT_SCRIPT_SRC,
    sha1: createHash('sha1').update(SLIDING_WINDOW_LIMIT_SCRIPT_SRC, 'utf8').digest('hex'),
};

interface WindowConfig {
    requests: number;
    windowSeconds: number;
}

export interface LimitsEnforceArgs {
    apiKeyId: string;
    rateLimit: WindowConfig;
    sustainedRateLimit: WindowConfig;
    quota: { requestsPerMonth: number };
}

export type LimitsEnforceResult =
    | {
          allowed: true;
          rateLimit: { limit: number; remaining: number; resetMs: number };
          quota: { limit: number; used: number; remaining: number; resetMs: number };
      }
    | {
          allowed: false;
          service: 'rateLimit' | 'sustainedRateLimit' | 'quota';
          retryAfterMs: number;
      };

export interface LimitsDeps {
    redis: LimitsRedis;
    now?: () => number;
}

function getMonthKeyUtc(now: Date): string {
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

function msUntilNextMonthUtc(now: Date): number {
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    return Math.max(0, nextMonthStart.getTime() - now.getTime());
}

function decodeWindow(value: unknown, label: string): WindowConfig {
    const obj = value as { requests?: unknown; windowSeconds?: unknown } | null;
    const requests = typeof obj?.requests === 'number' ? obj.requests : NaN;
    const windowSeconds = typeof obj?.windowSeconds === 'number' ? obj.windowSeconds : NaN;
    if (!Number.isFinite(requests) || requests <= 0 || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
        throw new InvalidArgsError(`${label} must be { requests > 0, windowSeconds > 0 }`);
    }
    return { requests: Math.floor(requests), windowSeconds: Math.floor(windowSeconds) };
}

export function decodeLimitsEnforceArgs(raw: unknown): LimitsEnforceArgs {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const apiKeyId = typeof obj.apiKeyId === 'string' ? obj.apiKeyId.trim() : '';
    if (!apiKeyId || apiKeyId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(apiKeyId)) {
        throw new InvalidArgsError('apiKeyId must be a short alphanumeric id');
    }
    const quotaObj = obj.quota as { requestsPerMonth?: unknown } | null;
    const requestsPerMonth = typeof quotaObj?.requestsPerMonth === 'number' ? quotaObj.requestsPerMonth : NaN;
    if (!Number.isFinite(requestsPerMonth) || requestsPerMonth <= 0) {
        throw new InvalidArgsError('quota.requestsPerMonth must be a positive number');
    }
    return {
        apiKeyId,
        rateLimit: decodeWindow(obj.rateLimit, 'rateLimit'),
        sustainedRateLimit: decodeWindow(obj.sustainedRateLimit, 'sustainedRateLimit'),
        quota: { requestsPerMonth: Math.floor(requestsPerMonth) },
    };
}

async function slidingWindow(
    redis: LimitsRedis,
    identifier: string,
    cfg: WindowConfig,
    nowMs: number,
): Promise<{ success: boolean; limit: number; remaining: number; resetMs: number }> {
    const windowMs = cfg.windowSeconds * 1000;
    const currentWindow = Math.floor(nowMs / windowMs);
    const base = `ratelimit:${identifier}`;
    const keys = [`${base}:${currentWindow}`, `${base}:${currentWindow - 1}`, ''];
    const args = [cfg.requests, nowMs, windowMs, 1];

    let result: [number, number];
    try {
        result = await redis.evalsha<[number, number]>(SLIDING_WINDOW_LIMIT_SCRIPT.sha1, keys, args);
    } catch (err) {
        if (!(err instanceof Error) || !err.message.includes('NOSCRIPT')) throw err;
        result = await redis.eval<[number, number]>(SLIDING_WINDOW_LIMIT_SCRIPT.script, keys, args);
    }
    const remaining = Number(result[0]);
    return {
        success: remaining >= 0,
        limit: Number(result[1]),
        remaining: Math.max(0, remaining),
        resetMs: (currentWindow + 1) * windowMs,
    };
}

export async function limitsEnforce(deps: LimitsDeps, raw: unknown): Promise<LimitsEnforceResult> {
    const args = decodeLimitsEnforceArgs(raw);
    const nowMs = deps.now ? deps.now() : Date.now();
    const now = new Date(nowMs);
    const quotaKey = `quota:${args.apiKeyId}:${getMonthKeyUtc(now)}`;
    const quotaTtlSeconds = Math.max(1, Math.ceil(msUntilNextMonthUtc(now) / 1000));

    const [rate, sustained, used] = await Promise.all([
        slidingWindow(deps.redis, `key:${args.apiKeyId}`, args.rateLimit, nowMs),
        slidingWindow(deps.redis, `key:${args.apiKeyId}:sustained`, args.sustainedRateLimit, nowMs),
        deps.redis.quotaIncr(quotaKey, quotaTtlSeconds),
    ]);

    if (!rate.success) {
        return { allowed: false, service: 'rateLimit', retryAfterMs: Math.max(0, rate.resetMs - nowMs) };
    }
    if (!sustained.success) {
        return { allowed: false, service: 'sustainedRateLimit', retryAfterMs: Math.max(0, sustained.resetMs - nowMs) };
    }
    if (used > args.quota.requestsPerMonth) {
        return { allowed: false, service: 'quota', retryAfterMs: msUntilNextMonthUtc(now) };
    }

    return {
        allowed: true,
        rateLimit: { limit: rate.limit, remaining: rate.remaining, resetMs: rate.resetMs },
        quota: {
            limit: args.quota.requestsPerMonth,
            used,
            remaining: Math.max(0, args.quota.requestsPerMonth - used),
            resetMs: nowMs + msUntilNextMonthUtc(now),
        },
    };
}
