/**
 * Shared prompt enrichment for SARIF-producing discovery providers
 * (semgrep, opengrep). Injects target location context so the AI only
 * analyzes the specific code location discovered by the scanner.
 */

export function buildSarifTargetPromptEnrichment(
  file: string,
  startLine: number,
  endLine: number,
): string {
  return `\n\nTARGET LOCATION:

You are analyzing a specific code location:
- File: ${file}
- Lines: ${startLine}-${endLine}

You MUST:
- Analyze ONLY this specific target location — do not search for or report issues at other locations
- You may read other files to understand context (e.g., imports, type definitions, data flow), but only report issues for this target
- If the code at this location is not vulnerable, return {"issues": []} — do not "spend" the target by reporting an issue you noticed somewhere else in the file
- Do NOT scan the broader repository for other instances of this vulnerability pattern

REPORTING RULES (strict — these prevent cross-target hallucinations):
- Each reported issue's "file"/"startLine"/"endLine" MUST point at this target's range above, OR at a line inside a function this target directly/transitively calls. They must NOT point at a sibling location (e.g. another function, another route handler, another class) that simply happens to live in the same file. If that sibling is genuinely vulnerable, it has its own target run — leave it alone here.

DESCRIPTION OPENING (mandatory output contract):
- Your description's first heading MUST identify the entry point this target represents — its function name, route path+verb, class method, or equivalent — exactly as it appears in the source. For example: a route handler → "## Missing X in DELETE /:id"; a function → "## Missing X in processPayment".
- The rest of the description must then describe THAT specific symbol's vulnerability — not a sibling's. If, while writing, you find yourself describing a different route/function than the one you opened with, stop: you are hallucinating across targets. Discard the issue and return {"issues": []}.
- If you noticed a real vulnerability while reading the file but it is in a sibling location, do NOT smuggle it into this target's report. That sibling has its own target run.
`;
}
