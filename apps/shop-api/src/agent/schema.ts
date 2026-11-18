import type { JSONSchema7 } from 'ai';

// DeepSeek currently rejects typeless `oneOf` nodes emitted by Zod 4. For
// discriminated object unions only, anyOf has exactly the same meaning because
// the required discriminator constants make the branches mutually exclusive.
// Refuse arbitrary oneOf rewrites: they could weaken the original schema.
export function normalizeDeepSeekSchema(schema: JSONSchema7): JSONSchema7 {
  function walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    const out = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    if (Array.isArray(out.oneOf)) {
      const branches = out.oneOf as Record<string, unknown>[];
      const firstProperties = branches[0]?.properties as Record<string, Record<string, unknown>> | undefined;
      const disjoint = Object.keys(firstProperties ?? {}).some(key => {
        const constants: unknown[] = [];
        for (const branch of branches) {
          const properties = branch.properties as Record<string, Record<string, unknown>> | undefined;
          if (branch.type !== 'object' || !Array.isArray(branch.required) || !branch.required.includes(key) || !properties?.[key] || !Object.hasOwn(properties[key], 'const')) return false;
          constants.push(properties[key].const);
        }
        return constants.length > 0 && new Set(constants.map(v => JSON.stringify(v))).size === constants.length;
      });
      if (!disjoint || out.anyOf !== undefined) throw new Error('Cannot safely normalize a non-discriminated oneOf schema');
      out.anyOf = out.oneOf; delete out.oneOf;
    }
    return out;
  }
  return walk(schema) as JSONSchema7;
}
