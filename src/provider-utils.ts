/**
 * Shared utilities for agent providers.
 */

// JSON schema for structured output (matches spec Section 4.4).
// Shared across providers to ensure consistent output format.
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          description: { type: 'string' },
          dataFlow: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                lineNumber: { type: 'integer' },
                label: { type: 'string' },
              },
              required: ['file', 'lineNumber', 'label'],
              additionalProperties: false,
            },
          },
        },
        required: ['file', 'startLine', 'endLine', 'description'],
        additionalProperties: false,
      },
    },
    // Mode-scoped: `verdict` and `rationale` are only consumed when a check
    // runs in false-positive-validation mode (checkTarget.analysisMode). They
    // are declared in this shared schema so structured-output models are
    // permitted to return them; in all other modes the scanner ignores them.
    verdict: { type: 'string', enum: ['true-positive', 'false-positive'] },
    rationale: { type: 'string' },
    // Optional fields the response parser already understands. Declared here so
    // structured-output models are permitted to return them.
    flagged: { type: 'boolean' },
    summary: { type: 'string' },
    analysisNotes: { type: 'string' },
  },
  required: ['issues'],
  additionalProperties: false,
} as const;
