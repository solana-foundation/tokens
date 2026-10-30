import { describe, expect, it } from 'bun:test';

import { MemorystoreClient } from './memorystore';

interface RecordedCall {
    cmd: string;
    args: unknown[];
}

function makeChainStub(execResult: Array<[Error | null, unknown]> | null = []) {
    const calls: RecordedCall[] = [];
    const make = (): Record<string, unknown> => {
        const obj: Record<string, unknown> = {
            incr(...args: unknown[]) {
                calls.push({ cmd: 'incr', args });
                return obj;
            },
            expire(...args: unknown[]) {
                calls.push({ cmd: 'expire', args });
                return obj;
            },
            hincrby(...args: unknown[]) {
                calls.push({ cmd: 'hincrby', args });
                return obj;
            },
            hset(...args: unknown[]) {
                calls.push({ cmd: 'hset', args });
                return obj;
            },
            set(...args: unknown[]) {
                calls.push({ cmd: 'set', args });
                return obj;
            },
            async exec() {
                return execResult;
            },
        };
        return obj;
    };
    const chain = make();
    return { chain, calls };
}

type SetArgs = [key: string, value: string, ...rest: unknown[]];

function makeClientStub(opts?: {
    pipelineExecResult?: Array<[Error | null, unknown]> | null;
}) {
    const calls: RecordedCall[] = [];
    const { chain, calls: pipelineCalls } = makeChainStub(opts?.pipelineExecResult);

    const stub = {
        async get(key: string) {
            calls.push({ cmd: 'get', args: [key] });
            if (key === '__json__') return '{"a":1}';
            if (key === '__null__') return null;
            return 'raw';
        },
        async set(...args: SetArgs) {
            calls.push({ cmd: 'set', args });
            if (args[args.length - 1] === 'NX' && args[0] === '__nx-miss__') return null;
            return 'OK';
        },
        pipeline() {
            return chain;
        },
        async eval(...args: unknown[]) {
            calls.push({ cmd: 'eval', args });
            return 42;
        },
        async evalsha(...args: unknown[]) {
            calls.push({ cmd: 'evalsha', args });
            return 42;
        },
        async script(...args: unknown[]) {
            calls.push({ cmd: 'script', args });
            return 'sha1-fingerprint';
        },
        async quit() {
            calls.push({ cmd: 'quit', args: [] });
        },
    };

    return {
        client: new MemorystoreClient(stub as never),
        calls,
        pipelineCalls,
    };
}

function expectArgs(actual: unknown[], expected: unknown[]): void {
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
        expect(actual[i]).toBe(expected[i]);
    }
}

describe('MemorystoreClient.get', () => {
    it('parses JSON when the stored value is valid JSON', async () => {
        const { client } = makeClientStub();
        const value = (await client.get<{ a: number }>('__json__')) as { a: number };
        expect(value.a).toBe(1);
    });

    it('returns the raw string when stored value is not JSON', async () => {
        const { client } = makeClientStub();
        const value = await client.get('plain-key');
        expect(value).toBe('raw');
    });

    it('returns null when key is missing', async () => {
        const { client } = makeClientStub();
        const value = await client.get('__null__');
        expect(value).toBe(null);
    });
});

describe('MemorystoreClient.set', () => {
    it('issues a bare SET with no options', async () => {
        const { client, calls } = makeClientStub();
        const result = await client.set('k', 'v');
        expect(result).toBe('OK');
        const setCalls = calls.filter(c => c.cmd === 'set');
        expect(setCalls.length).toBe(1);
        expectArgs(setCalls[0]!.args, ['k', 'v']);
    });

    it('issues SET key value EX <s> NX when both ex+nx are set', async () => {
        const { client, calls } = makeClientStub();
        await client.set('k', 'v', { ex: 60, nx: true });
        const setCalls = calls.filter(c => c.cmd === 'set');
        expectArgs(setCalls[0]!.args, ['k', 'v', 'EX', 60, 'NX']);
    });

    it('issues SET key value PX <ms> when only px is set', async () => {
        const { client, calls } = makeClientStub();
        await client.set('k', 'v', { px: 250 });
        const setCalls = calls.filter(c => c.cmd === 'set');
        expectArgs(setCalls[0]!.args, ['k', 'v', 'PX', 250]);
    });

    it('stringifies numeric values', async () => {
        const { client, calls } = makeClientStub();
        await client.set('k', 7);
        const setCalls = calls.filter(c => c.cmd === 'set');
        expectArgs(setCalls[0]!.args, ['k', '7']);
    });

    it('returns null on NX miss', async () => {
        const { client } = makeClientStub();
        const result = await client.set('__nx-miss__', 'v', { nx: true });
        expect(result).toBe(null);
    });
});

describe('MemorystorePipeline', () => {
    it('records the same incr+expire(NX)+exec sequence that enforceUpstashLimits emits', async () => {
        const { client, pipelineCalls } = makeClientStub({
            pipelineExecResult: [
                [null, 1],
                [null, 1],
            ],
        });
        const pipe = client.pipeline();
        pipe.incr('quota:abc:2026-06').expire('quota:abc:2026-06', 12_345, 'NX');
        const result = await pipe.exec<[number, 0 | 1]>();
        expect(result[0]).toBe(1);
        expect(pipelineCalls[0]!.cmd).toBe('incr');
        expectArgs(pipelineCalls[0]!.args, ['quota:abc:2026-06']);
        expect(pipelineCalls[1]!.cmd).toBe('expire');
        expectArgs(pipelineCalls[1]!.args, ['quota:abc:2026-06', 12_345, 'NX']);
    });

    it('emits hincrby followed by expire (no NX flag)', async () => {
        const { client, pipelineCalls } = makeClientStub({
            pipelineExecResult: [
                [null, 1],
                [null, 1],
            ],
        });
        const pipe = client.pipeline();
        pipe.hincrby('usage:day:2026-06-24', 'totalCalls', 1).expire('usage:day:2026-06-24', 172_800);
        await pipe.exec();
        expect(pipelineCalls[0]!.cmd).toBe('hincrby');
        expectArgs(pipelineCalls[0]!.args, ['usage:day:2026-06-24', 'totalCalls', 1]);
        expect(pipelineCalls[1]!.cmd).toBe('expire');
        expectArgs(pipelineCalls[1]!.args, ['usage:day:2026-06-24', 172_800]);
    });

    it('emits hset with the field and value as separate arguments', async () => {
        const { client, pipelineCalls } = makeClientStub({ pipelineExecResult: [[null, 1]] });
        const pipe = client.pipeline();
        pipe.hset('usage:v1:dirty', 'usage:v1:day:2026-06-24:prj', 'm_1');
        await pipe.exec();
        expect(pipelineCalls[0]!.cmd).toBe('hset');
        expectArgs(pipelineCalls[0]!.args, ['usage:v1:dirty', 'usage:v1:day:2026-06-24:prj', 'm_1']);
    });

    it('throws if any pipeline command surfaced an error', async () => {
        const { client } = makeClientStub({
            pipelineExecResult: [[new Error('boom'), null]],
        });
        const pipe = client.pipeline();
        pipe.incr('x');
        let threw = false;
        try {
            await pipe.exec();
        } catch (err) {
            threw = true;
            expect((err as Error).message.includes('boom')).toBe(true);
        }
        expect(threw).toBe(true);
    });

    it('throws when the underlying pipeline returns null (transaction discarded)', async () => {
        const { client } = makeClientStub({ pipelineExecResult: null });
        const pipe = client.pipeline();
        pipe.incr('x');
        let threw = false;
        try {
            await pipe.exec();
        } catch (err) {
            threw = true;
            expect((err as Error).message.includes('null')).toBe(true);
        }
        expect(threw).toBe(true);
    });
});

describe('MemorystoreClient.eval / evalsha / scriptLoad', () => {
    it('passes keys.length as numKeys followed by keys then args', async () => {
        const { client, calls } = makeClientStub();
        await client.eval('return 1', ['k1', 'k2'], ['a1', 2]);
        const evalCall = calls.find(c => c.cmd === 'eval')!;
        expectArgs(evalCall.args, ['return 1', 2, 'k1', 'k2', 'a1', 2]);
    });

    it('evalsha forwards the sha and the same key/args layout', async () => {
        const { client, calls } = makeClientStub();
        await client.evalsha('abc123', ['k1'], ['a1']);
        const sha = calls.find(c => c.cmd === 'evalsha')!;
        expectArgs(sha.args, ['abc123', 1, 'k1', 'a1']);
    });

    it('scriptLoad uses SCRIPT LOAD and returns the sha as a string', async () => {
        const { client, calls } = makeClientStub();
        const sha = await client.scriptLoad('return 1');
        expect(sha).toBe('sha1-fingerprint');
        const scriptCall = calls.find(c => c.cmd === 'script')!;
        expectArgs(scriptCall.args, ['LOAD', 'return 1']);
    });
});
