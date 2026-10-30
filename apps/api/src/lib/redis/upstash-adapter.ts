import type { Redis as UpstashRedis } from '@upstash/redis';

import type {
    RedisClient,
    RedisExpireFlag,
    RedisPipeline,
    RedisSetOptions,
} from './client';

type UpstashPipeline = ReturnType<UpstashRedis['pipeline']>;

class UpstashPipelineAdapter implements RedisPipeline {
    constructor(private readonly pipe: UpstashPipeline) {}

    incr(key: string): this {
        this.pipe.incr(key);
        return this;
    }

    expire(key: string, seconds: number, flag?: RedisExpireFlag): this {
        if (flag) {
            this.pipe.expire(key, seconds, flag);
        } else {
            this.pipe.expire(key, seconds);
        }
        return this;
    }

    hincrby(key: string, field: string, delta: number): this {
        this.pipe.hincrby(key, field, delta);
        return this;
    }

    hset(key: string, field: string, value: string): this {
        this.pipe.hset(key, { [field]: value });
        return this;
    }

    set(key: string, value: string | number, options?: RedisSetOptions): this {
        if (!options) {
            this.pipe.set(key, value);
            return this;
        }
        const opts: Record<string, unknown> = {};
        if (options.ex !== undefined) opts.ex = options.ex;
        if (options.px !== undefined) opts.px = options.px;
        if (options.nx) opts.nx = true;
        this.pipe.set(key, value, opts);
        return this;
    }

    async exec<TResult extends ReadonlyArray<unknown> = unknown[]>(): Promise<TResult> {
        const result = await this.pipe.exec();
        return result as unknown as TResult;
    }
}

export class UpstashRedisClientAdapter implements RedisClient {
    constructor(private readonly client: UpstashRedis) {}

    get<T = string>(key: string): Promise<T | null> {
        return this.client.get<T>(key);
    }

    async set(key: string, value: string | number, options?: RedisSetOptions): Promise<'OK' | null> {
        if (!options) {
            const result = await this.client.set(key, value);
            return result === 'OK' ? 'OK' : null;
        }
        const opts: Record<string, unknown> = {};
        if (options.ex !== undefined) opts.ex = options.ex;
        if (options.px !== undefined) opts.px = options.px;
        if (options.nx) opts.nx = true;
        const result = await this.client.set(key, value, opts);
        return result === 'OK' ? 'OK' : null;
    }

    pipeline(): RedisPipeline {
        return new UpstashPipelineAdapter(this.client.pipeline());
    }

    async eval<T = unknown>(script: string, keys: string[], args: Array<string | number>): Promise<T> {
        const result = await this.client.eval(script, keys, args);
        return result as T;
    }

    async evalsha<T = unknown>(sha: string, keys: string[], args: Array<string | number>): Promise<T> {
        const result = await this.client.evalsha(sha, keys, args);
        return result as T;
    }

    async scriptLoad(script: string): Promise<string> {
        const result = await this.client.scriptLoad(script);
        return String(result);
    }
}
