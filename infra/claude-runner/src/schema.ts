// Structured output takes one object schema at the root: the Agent SDK result comes back
// is_error for a schema whose root is a union (oneOf/anyOf/allOf), while the same union
// nested under an object property works. Such a schema is sent wrapped as {result: <schema>}
// and the output is unwrapped, so a client gets exactly the shape its own schema describes.

export type JsonSchema = Record<string, unknown>;

const UNION_KEYS = ['oneOf', 'anyOf', 'allOf'];

export function wrapRootUnion(schema: JsonSchema): { schema: JsonSchema; wrapped: boolean } {
  if (!UNION_KEYS.some((key) => Object.hasOwn(schema, key))) return { schema, wrapped: false };
  const { $schema, ...inner } = schema;
  return {
    schema: {
      ...($schema === undefined ? {} : { $schema }),
      type: 'object',
      required: ['result'],
      additionalProperties: false,
      properties: { result: inner },
    },
    wrapped: true,
  };
}

/** The client's value from the SDK's structured output; undefined when a wrapped output lacks `result`. */
export function unwrapResult(output: unknown, wrapped: boolean): unknown {
  if (!wrapped) return output;
  if (typeof output !== 'object' || output === null || Array.isArray(output) || !Object.hasOwn(output, 'result')) return undefined;
  return (output as { result: unknown }).result;
}
