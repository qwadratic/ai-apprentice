import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapResult, wrapRootUnion } from '../src/schema.ts';

const order = { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { const: 'order_view' } } };
const incomplete = { type: 'object', required: ['outcome'], additionalProperties: false, properties: { outcome: { const: 'incomplete' } } };

test('a root oneOf, anyOf or allOf is wrapped under result, keeping $schema at the root', () => {
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const { schema, wrapped } = wrapRootUnion({ $schema: 'http://json-schema.org/draft-07/schema#', [key]: [order, incomplete] });
    assert.equal(wrapped, true);
    assert.deepEqual(schema, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['result'],
      additionalProperties: false,
      properties: { result: { [key]: [order, incomplete] } },
    });
  }
});

test('a root union next to type: object is wrapped too, and no $schema is invented', () => {
  const { schema, wrapped } = wrapRootUnion({ type: 'object', oneOf: [order, incomplete] });
  assert.equal(wrapped, true);
  assert.equal(Object.hasOwn(schema, '$schema'), false);
  assert.deepEqual(schema.properties, { result: { type: 'object', oneOf: [order, incomplete] } });
});

test('an object schema, even with a nested union, passes through unchanged', () => {
  const nested = { type: 'object', required: ['result'], properties: { result: { oneOf: [order, incomplete] } } };
  for (const s of [order, nested]) {
    const out = wrapRootUnion(s);
    assert.equal(out.wrapped, false);
    assert.equal(out.schema, s);
  }
});

test('unwrap returns the client value, including null, and undefined when result is missing', () => {
  assert.deepEqual(unwrapResult({ result: { kind: 'order_view' } }, true), { kind: 'order_view' });
  assert.equal(unwrapResult({ result: null }, true), null);
  for (const bad of [{}, { kind: 'order_view' }, null, [], 'text']) assert.equal(unwrapResult(bad, true), undefined);
  const plain = { kind: 'order_view' };
  assert.equal(unwrapResult(plain, false), plain);
});
