import IORedis from 'ioredis';

export interface LimitsRedis {
    evalsha<T>(sha: string, keys: string[], args: Array<string | number>): Promise<T>;
    eval<T>(script: string, keys: string[], args: Array<string | number>): Promise<T>;
    quotaIncr(key: string, ttlSeconds: number): Promise<number>;
}

export function makeLimitsRedis(opts: { host: string; port: number }): LimitsRedis {
    const client = new IORedis({
        host: opts.host,
        port: opts.port,
        connectTimeout: 1000,
        commandTimeout: 500,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
    });
    client.on('error', err => {
        console.error(JSON.stringify({ event: 'limits_redis_error', message: err.message }));
    });
    return {
        async evalsha<T>(sha: string, keys: string[], args: Array<string | number>): Promise<T> {
            return (await client.evalsha(sha, keys.length, ...keys, ...args.map(String))) as T;
        },
        async eval<T>(script: string, keys: string[], args: Array<string | number>): Promise<T> {
            return (await client.eval(script, keys.length, ...keys, ...args.map(String))) as T;
        },
        async quotaIncr(key: string, ttlSeconds: number): Promise<number> {
            const results = await client.multi().incr(key).call('EXPIRE', key, ttlSeconds, 'NX').exec();
            if (results === null) throw new Error('quota MULTI discarded');
            const [incrErr, used] = results[0]!;
            if (incrErr) throw incrErr;
            return Number(used);
        },
    };
}
