import { createHash } from 'node:crypto';

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

const SLIDING_WINDOW_REMAINING_TOKENS_SCRIPT_SRC = `
  local currentKey  = KEYS[1]           -- identifier including prefixes
  local previousKey = KEYS[2]           -- key of the previous bucket
  local dynamicLimitKey = KEYS[3]       -- optional: key for dynamic limit in redis
  local tokens      = tonumber(ARGV[1]) -- default tokens per window
  local now         = ARGV[2]           -- current timestamp in milliseconds
  local window      = ARGV[3]           -- interval in milliseconds

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

  local usedTokens = requestsInPreviousWindow + requestsInCurrentWindow
  return {effectiveLimit - usedTokens, effectiveLimit}
`;

/**
 * Usage-aggregate drain (see `src/effect/usage-drain.ts`). Every key a script
 * touches is declared in KEYS so the scripts stay valid on clustered Redis.
 */
const USAGE_DRAIN_LIST_DIRTY_SCRIPT_SRC = `
  local dirtyKey = KEYS[1]           -- hash used as a set of dirty usage keys
  local limit    = tonumber(ARGV[1]) -- max dirty keys to return

  local fields = redis.call("HKEYS", dirtyKey)
  local out = {}
  for i = 1, math.min(#fields, limit) do
    out[i] = fields[i]
  end
  return out
`;

const USAGE_DRAIN_TAKE_SCRIPT_SRC = `
  local dirtyKey = KEYS[1] -- hash used as a set of dirty usage keys

  -- KEYS[2..n] are usage hashes: read + delete each atomically so increments
  -- landing after the read start a fresh hash instead of being lost.
  local out = {}
  for i = 2, #KEYS do
    out[i - 1] = redis.call("HGETALL", KEYS[i])
    redis.call("DEL", KEYS[i])
    redis.call("HDEL", dirtyKey, KEYS[i])
  end
  return out
`;

const USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT_SRC = `
  return redis.call("MGET", unpack(KEYS))
`;

function digest(script: string): string {
    return createHash('sha1').update(script, 'utf8').digest('hex');
}

export const SLIDING_WINDOW_LIMIT_SCRIPT = {
    script: SLIDING_WINDOW_LIMIT_SCRIPT_SRC,
    sha1: digest(SLIDING_WINDOW_LIMIT_SCRIPT_SRC),
};

export const SLIDING_WINDOW_REMAINING_TOKENS_SCRIPT = {
    script: SLIDING_WINDOW_REMAINING_TOKENS_SCRIPT_SRC,
    sha1: digest(SLIDING_WINDOW_REMAINING_TOKENS_SCRIPT_SRC),
};

export const USAGE_DRAIN_LIST_DIRTY_SCRIPT = {
    script: USAGE_DRAIN_LIST_DIRTY_SCRIPT_SRC,
    sha1: digest(USAGE_DRAIN_LIST_DIRTY_SCRIPT_SRC),
};

export const USAGE_DRAIN_TAKE_SCRIPT = {
    script: USAGE_DRAIN_TAKE_SCRIPT_SRC,
    sha1: digest(USAGE_DRAIN_TAKE_SCRIPT_SRC),
};

export const USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT = {
    script: USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT_SRC,
    sha1: digest(USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT_SRC),
};
