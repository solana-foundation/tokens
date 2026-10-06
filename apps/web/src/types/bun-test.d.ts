declare module 'bun:test' {
    type TestCallback = () => void | Promise<void>;

    export function describe(name: string, fn: TestCallback): void;
    export function it(name: string, fn: TestCallback): void;
    export const test: typeof it;
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
    export function expect<T>(value: T): {
        toBe(expected: unknown): void;
        toEqual(expected: unknown): void;
        toBeNull(): void;
        toContain(expected: string): void;
        toHaveLength(expected: number): void;
        toMatchObject(expected: object): void;
        toBeGreaterThan(expected: number): void;
        toBeGreaterThanOrEqual(expected: number): void;
        toBeLessThan(expected: number): void;
        toBeLessThanOrEqual(expected: number): void;
        toBeCloseTo(expected: number, numDigits?: number): void;
    };
}
