declare module 'bun:test' {
    export function describe(name: string, fn: () => void): void;
    export function it(name: string, fn: () => void): void;
    export const test: typeof it;
    export function beforeEach(fn: () => void | Promise<void>): void;
    export function afterEach(fn: () => void | Promise<void>): void;
    export const mock: {
        module(specifier: string, factory: () => unknown): void;
    };
    interface Matchers {
        toBe(expected: unknown): void;
        toBeCloseTo(expected: number, numDigits?: number): void;
        toBeDefined(): void;
        toBeGreaterThan(expected: number): void;
        toBeGreaterThanOrEqual(expected: number): void;
        toBeInstanceOf(expected: unknown): void;
        toBeLessThan(expected: number): void;
        toBeLessThanOrEqual(expected: number): void;
        toBeNull(): void;
        toContain(expected: unknown): void;
        toEqual(expected: unknown): void;
    }
    export function expect<T>(value: T): Matchers & { not: Matchers };
}
