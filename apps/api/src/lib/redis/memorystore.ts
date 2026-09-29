import IORedis, { type Redis as IORedisClient, type ChainableCommander } from 'ioredis';

import {
    loadMemorystoreEnv,
    type EnvLike,
    type RedisClient,
    type RedisExpireFlag,
    type RedisPipeline,
    type RedisSetOptions,
} from './client';

class MemorystorePipeline implements RedisPipeline {
    constructor(private readonly chain: ChainableCommander) {}

    incr(key: string): this {
        this.chain.incr(key);
        return this;
    }

    expire(key: string, seconds: number, flag?: RedisExpireFlag): this {
        if (flag) {
            (this.chain as unknown as {
                expire: (key: string, seconds: number, flag: RedisExpireFlag) => unknown;
            }).expire(key, seconds, flag);
        } else {
            this.chain.expire(key, seconds);
        }
        return this;
    }

    hincrby(key: string, field: string, delta: number): this {
        this.chain.hincrby(key, field, delta);
        return this;
    }

    hset(key: string, field: string, value: string): this {
        this.chain.hset(key, field, value);
        return this;
    }

    set(key: string, value: string | number, options?: RedisSetOptions): this {
        const stringValue = typeof value === 'number' ? String(value) : value;
        if (!options) {
            this.chain.set(key, stringValue);
            return this;
        }
        if (options.ex !== undefined && options.nx) {
            this.chain.set(key, stringValue, 'EX', options.ex, 'NX');
        } else if (options.px !== undefined && options.nx) {
            this.chain.set(key, stringValue, 'PX', options.px, 'NX');
        } else if (options.ex !== undefined) {
            this.chain.set(key, stringValue, 'EX', options.ex);
        } else if (options.px !== undefined) {
            this.chain.set(key, stringValue, 'PX', options.px);
        } else if (options.nx) {
            this.chain.set(key, stringValue, 'NX');
        } else {
            this.chain.set(key, stringValue);
        }
        return this;
    }

    async exec<TResult extends ReadonlyArray<unknown> = unknown[]>(): Promise<TResult> {
        const results = await this.chain.exec();
        if (results === null) {
            throw new Error('Memorystore pipeline returned null (transaction discarded)');
        }
        const errors = results
            .map(([err], i) => (err ? { index: i, err } : null))
            .filter((x): x is { index: number; err: Error } => x !== null);
        if (errors.length > 0) {
            const summary = errors.map(e => `${e.index}: ${e.err.message}`).join('; ');
            const aggregate = new Error(`Memorystore pipeline had ${errors.length} error(s): ${summary}`);
            (aggregate as unknown as { errors: Error[] }).errors = errors.map(e => e.err);
            throw aggregate;
        }
        return results.map(([, value]) => value) as unknown as TResult;
    }
}

export class MemorystoreClient implements RedisClient {
    private readonly client: IORedisClient;

    constructor(client: IORedisClient) {
        this.client = client;
    }

    static fromEnv(env: EnvLike = process.env as EnvLike): MemorystoreClient {
        const cfg = loadMemorystoreEnv(env);
        const client = new IORedis({
            host: cfg.host,
            port: cfg.port,
            ...(cfg.authString ? { password: cfg.authString } : {}),
            ...(cfg.tls ? { tls: {} } : {}),
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
        });
        return new MemorystoreClient(client);
    }

    async get<T = string>(key: string): Promise<T | null> {
        const raw = await this.client.get(key);
        if (raw === null) return null;
        try {
            return JSON.parse(raw) as T;
        } catch {
            return raw as unknown as T;
        }
    }

    async set(key: string, value: string | number, options?: RedisSetOptions): Promise<'OK' | null> {
        const stringValue = typeof value === 'number' ? String(value) : value;
        let result: string | null;
        if (!options) {
            result = await this.client.set(key, stringValue);
        } else if (options.ex !== undefined && options.nx) {
            result = await this.client.set(key, stringValue, 'EX', options.ex, 'NX');
        } else if (options.px !== undefined && options.nx) {
            result = await this.client.set(key, stringValue, 'PX', options.px, 'NX');
        } else if (options.ex !== undefined) {
            result = await this.client.set(key, stringValue, 'EX', options.ex);
        } else if (options.px !== undefined) {
            result = await this.client.set(key, stringValue, 'PX', options.px);
        } else if (options.nx) {
            result = await this.client.set(key, stringValue, 'NX');
        } else {
            result = await this.client.set(key, stringValue);
        }
        return result === 'OK' ? 'OK' : null;
    }

    pipeline(): RedisPipeline {
        return new MemorystorePipeline(this.client.pipeline());
    }

    async eval<T = unknown>(script: string, keys: string[], args: Array<string | number>): Promise<T> {
        const result = await this.client.eval(script, keys.length, ...keys, ...args);
        return result as T;
    }

    async evalsha<T = unknown>(sha: string, keys: string[], args: Array<string | number>): Promise<T> {
        const result = await this.client.evalsha(sha, keys.length, ...keys, ...args);
        return result as T;
    }

    async scriptLoad(script: string): Promise<string> {
        const sha = await this.client.script('LOAD', script);
        return String(sha);
    }

    async quit(): Promise<void> {
        await this.client.quit();
    }

    rawClient(): IORedisClient {
        return this.client;
    }
}
