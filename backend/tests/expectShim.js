/**
 * Minimal expect shim (used with node:test instead of vitest, which hung in
 * this environment). Supports the assertion styles used in api.test.js.
 */
import assert from "node:assert/strict";

class Expect {
  constructor(actual) {
    this.actual = actual;
  }
  toBe(v) {
    assert.strictEqual(this.actual, v);
  }
  toBeDefined() {
    assert.notStrictEqual(this.actual, undefined);
  }
  toBeUndefined() {
    assert.strictEqual(this.actual, undefined);
  }
  toBeNull() {
    assert.strictEqual(this.actual, null);
  }
  toBeCloseTo(v, numDigits) {
    const digits = numDigits ?? 2;
    const diff = Math.abs(this.actual - v);
    assert.ok(
      diff < 0.5 * Math.pow(10, -digits),
      `expected ${this.actual} to be close to ${v} within ${digits} digits (diff ${diff})`,
    );
  }
  toHaveLength(n) {
    assert.strictEqual(this.actual.length, n);
  }
  toHaveProperty(k) {
    assert.ok(Object.prototype.hasOwnProperty.call(this.actual, k));
  }
  toBeGreaterThan(n) {
    assert.ok(this.actual > n);
  }
  toBeLessThan(n) {
    assert.ok(this.actual < n);
  }
  toBeGreaterThanOrEqual(n) {
    assert.ok(this.actual >= n);
  }
  toContain(sub) {
    assert.ok(
      this.actual != null && this.actual.includes(sub),
      `expected ${JSON.stringify(this.actual)} to contain ${JSON.stringify(sub)}`,
    );
  }
  toBeTruthy() {
    assert.ok(this.actual, `expected ${this.actual} to be truthy`);
  }
  toBeFalsy() {
    assert.ok(!this.actual, `expected ${this.actual} to be falsy`);
  }
  toEqual(v) {
    assert.deepStrictEqual(this.actual, v);
  }
  toMatch(pattern) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    assert.ok(
      typeof this.actual === "string" && re.test(this.actual),
      `expected ${JSON.stringify(this.actual)} to match ${re}`,
    );
  }
  get not() {
    const self = this;
    return {
      toBe: (v) => assert.notStrictEqual(self.actual, v),
      toBeNull: () => assert.notStrictEqual(self.actual, null),
      toBeDefined: () => assert.strictEqual(self.actual, undefined),
      toBeUndefined: () => assert.notStrictEqual(self.actual, undefined),
      toEqual: (v) => assert.notDeepStrictEqual(self.actual, v),
      toInclude: (x) => assert.ok(!self.actual.includes(x)),
      toContain: (sub) => assert.ok(self.actual == null || !self.actual.includes(sub)),
      toMatch: (pattern) => {
        const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
        assert.ok(
          typeof self.actual !== "string" || !re.test(self.actual),
          `expected ${JSON.stringify(self.actual)} NOT to match ${re}`,
        );
      },
    };
  }
}

export function expect(actual) {
  return new Expect(actual);
}
