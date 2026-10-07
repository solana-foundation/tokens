export type RedisTarget = 'upstash' | 'memorystore';

export type RedisSetOptions = {
    ex?: number;
    px?: number;
    nx?: boolean;
};

export type RedisExpireFlag = 'NX' | 'XX' | 'GT' | 'LT';

export interface RedisPipeline {
    incr(key: string): this;
    expire(key: string, seconds: number, flag?: RedisExpireFlag): this;
    hincrby(key: string, field: string, delta: number): this;
    hset(key: string, field: string, value: string): this;
    set(key: string, value: string | number, options?: RedisSetOptions): this;
    exec<TResult extends ReadonlyArray<unknown> = unknown[]>(): Promise<TResult>;
}

export interface RedisClient {
    get<T = string>(key: string): Promise<T | null>;
    set(
        key: string,
        value: string | number,
        options?: RedisSetOptions,
    ): Promise<'OK' | null>;
    pipeline(): RedisPipeline;
    eval<T = unknown>(script: string, keys: string[], args: Array<string | number>): Promise<T>;
    evalsha<T = unknown>(sha: string, keys: string[], args: Array<string | number>): Promise<T>;
    scriptLoad(script: string): Promise<string>;
}

export type EnvLike = Record<string, string | undefined>;

export function getRedisTargetFromEnv(env: EnvLike = process.env as EnvLike): RedisTarget {
    const raw = env.TOKENS_REDIS_TARGET?.trim().toLowerCase();
    return raw === 'memorystore' ? 'memorystore' : 'upstash';
}

export function isMemorystoreEnabled(env: EnvLike = process.env as EnvLike): boolean {
    return getRedisTargetFromEnv(env) === 'memorystore';
}

export interface MemorystoreEnv {
    host: string;
    port: number;
    authString: string | null;
    tls: boolean;
}

export class MissingMemorystoreEnvError extends Error {
    constructor(name: string) {
        super(`Memorystore: missing required env var ${name}`);
        this.name = 'MissingMemorystoreEnvError';
    }
}

export function loadMemorystoreEnv(env: EnvLike = process.env as EnvLike): MemorystoreEnv {
    const host = env.REDIS_HOST?.trim();
    if (!host) throw new MissingMemorystoreEnvError('REDIS_HOST');
    const portRaw = env.REDIS_PORT?.trim();
    if (!portRaw) throw new MissingMemorystoreEnvError('REDIS_PORT');
    const port = Number(portRaw);
    if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
        throw new MissingMemorystoreEnvError('REDIS_PORT (not a valid port number)');
    }
    const authString = env.REDIS_AUTH_STRING?.trim() ?? null;
    const tlsRaw = env.REDIS_TLS?.trim().toLowerCase();
    const tls = tlsRaw === 'true' || tlsRaw === '1';
    return { host, port, authString: authString && authString.length > 0 ? authString : null, tls };
}
