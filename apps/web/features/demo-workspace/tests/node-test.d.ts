declare module 'node:test' {
  export function test(name: string, callback: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  type ErrorExpectation = RegExp | ((error: unknown) => boolean) | Record<string, unknown>;

  interface StrictAssert {
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    ok(value: unknown, message?: string | Error): asserts value;
    match(value: string, regexp: RegExp, message?: string | Error): void;
    throws(block: () => unknown, expectation?: ErrorExpectation, message?: string | Error): void;
  }

  const assert: StrictAssert;
  export default assert;
}
