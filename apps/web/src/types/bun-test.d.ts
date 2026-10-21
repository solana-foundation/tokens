declare module 'bun:test' {
    type TestCallback = () => void | Promise<void>;

    interface TestFunction {
        (name: string, fn: TestCallback): void;
        each<T extends readonly unknown[]>(
            cases: readonly T[],
        ): (name: string, fn: (...args: T) => void | Promise<void>) => void;
    }

    export function describe(name: string, fn: TestCallback): void;
    export const it: TestFunction;
    export const test: TestFunction;
    export function beforeEach(fn: TestCallback): void;
    export function afterEach(fn: TestCallback): void;
    export const mock: {
        module(specifier: string, factory: () => unknown): void;
    };
    export interface Mock<T extends (...args: never[]) => unknown> {
        (...args: Parameters<T>): ReturnType<T>;
        readonly mock: { calls: Array<Parameters<T>> };
        mockImplementation(fn: (...args: Parameters<T>) => ReturnType<T>): Mock<T>;
        mockRestore(): void;
    }
    export function spyOn<T extends object, K extends keyof T>(
        target: T,
        property: K,
    ): T[K] extends (...args: never[]) => unknown ? Mock<T[K]> : never;
    interface Matchers {
        toBe(expected: unknown): void;
        toEqual(expected: unknown): void;
        toBeNull(): void;
        toContain(expected: string): void;
        toHaveLength(expected: number): void;
        toMatch(expected: string | RegExp): void;
        toMatchObject(expected: object): void;
        toBeGreaterThan(expected: number): void;
        toBeGreaterThanOrEqual(expected: number): void;
        toBeLessThan(expected: number): void;
        toBeLessThanOrEqual(expected: number): void;
        toBeCloseTo(expected: number, numDigits?: number): void;
        toThrow(expected?: string | RegExp): void;
    }
    export function expect<T>(value: T): Matchers & {
        not: Matchers;
        rejects: { toThrow(expected?: string | RegExp): Promise<void> };
    };
}
