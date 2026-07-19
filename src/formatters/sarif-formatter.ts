/**
 * SARIF 2.1.0 output formatter.
 * Maps ScanResults to the SARIF schema for integration with
 * code scanning UIs (e.g. GitHub Code Scanning) and SARIF viewers.
 */

import type { ScanResults, SecurityIssue, DataFlowStep, ValidationRecord, CIMetadata } from '../types.js';
import type { OutputFormatter } from './types.js';

/** Maps aghast severity to SARIF result level. */
export function mapSeverityToLevel(severity: string | undefined): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
    case 'informational':
    default:
      return 'note';
  }
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
}

interface SarifRegion {
  startLine: number;
  endLine: number;
  snippet?: { text: string };
}

interface SarifThreadFlowLocation {
  location: {
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number };
    };
    message: { text: string };
  };
}

interface SarifCodeFlow {
  threadFlows: Array<{
    locations: SarifThreadFlowLocation[];
  }>;
}

interface SarifSuppression {
  kind: 'inSource' | 'external';
  justification?: string;
}

interface SarifResult {
  ruleId: string;
  message: { text: string };
  level?: 'error' | 'warning' | 'note';
  kind?: 'fail' | 'pass' | 'open' | 'review' | 'notApplicable' | 'informational';
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: SarifRegion;
    };
  }>;
  codeFlows?: SarifCodeFlow[];
  suppressions?: SarifSuppression[];
}

/**
 * SARIF invocation entry. We only populate it when CI metadata is available
 * (spec E.4) so SARIF output stays minimal for local runs.
 */
interface SarifInvocation {
  executionSuccessful: boolean;
  properties?: Record<string, string>;
}

interface SarifLog {
  $schema: string;
  version: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        semanticVersion: string;
        rules: SarifRule[];
      };
    };
    invocations?: SarifInvocation[];
    results: SarifResult[];
  }>;
}

export class SarifFormatter implements OutputFormatter {
  readonly id = 'sarif';
  readonly fileExtension = '.sarif';

  format(results: ScanResults): string {
    const rules = this.buildRules(results);
    const sarifResults = this.buildResults(results.issues);
    // False-positive-validation dismissals become SARIF "pass" results with a
    // suppression carrying the rationale. True positives are already covered by
    // results.issues above, so only false positives are emitted here.
    if (results.validations) {
      sarifResults.push(...this.buildValidationResults(results.validations));
    }
    const invocations = this.buildInvocations(results);

    const sarif: SarifLog = {
      $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'aghast',
              semanticVersion: results.version,
              rules,
            },
          },
          ...(invocations ? { invocations } : {}),
          results: sarifResults,
        },
      ],
    };

    return JSON.stringify(sarif, null, 2);
  }

  /**
   * Map CI/CD metadata (spec E.4) to a single SARIF invocation entry. The
   * `properties` bag is the conventional location for non-standard run
   * context in SARIF; we use stable, namespaced keys (`aghast.<field>`) so
   * downstream consumers can rely on the shape.
   */
  private buildInvocations(results: ScanResults): SarifInvocation[] | undefined {
    const ci: CIMetadata | undefined = results.metadata?.ciMetadata;
    if (!ci) return undefined;
    const properties: Record<string, string> = {};
    if (ci.jobUrl) properties['aghast.ciJobUrl'] = ci.jobUrl;
    if (ci.branch) properties['aghast.ciBranch'] = ci.branch;
    if (ci.pipelineSource) properties['aghast.ciPipelineSource'] = ci.pipelineSource;
    if (ci.jobStartedAt) properties['aghast.ciJobStartedAt'] = ci.jobStartedAt;
    if (Object.keys(properties).length === 0) return undefined;
    return [{ executionSuccessful: true, properties }];
  }

  private buildRules(results: ScanResults): SarifRule[] {
    const seen = new Map<string, SarifRule>();
    for (const check of results.checks) {
      if (!seen.has(check.checkId)) {
        seen.set(check.checkId, {
          id: check.checkId,
          name: check.checkName,
          shortDescription: { text: check.checkName },
        });
      }
    }
    return Array.from(seen.values());
  }

  private buildResults(issues: SecurityIssue[]): SarifResult[] {
    return issues.map((issue) => {
      const region: SarifRegion = {
        startLine: issue.startLine,
        endLine: issue.endLine,
      };
      if (issue.codeSnippet) {
        region.snippet = { text: issue.codeSnippet };
      }

      const result: SarifResult = {
        ruleId: issue.checkId,
        message: { text: issue.description },
        level: mapSeverityToLevel(issue.severity),
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: issue.file },
              region,
            },
          },
        ],
      };

      if (issue.dataFlow && issue.dataFlow.length > 0) {
        result.codeFlows = [this.buildCodeFlow(issue.dataFlow)];
      }

      return result;
    });
  }

  private buildValidationResults(validations: ValidationRecord[]): SarifResult[] {
    return validations
      .filter((v) => v.verdict === 'false-positive')
      .map((v) => {
        const region: SarifRegion = {
          startLine: v.target.startLine,
          endLine: v.target.endLine,
        };
        if (v.target.snippet) {
          region.snippet = { text: v.target.snippet };
        }
        // No `level` is set: per SARIF 2.1.0 `level` is meaningless for
        // `kind: "pass"` results, so it is intentionally omitted here (unlike
        // regular issue results, which always carry a severity-derived level).
        return {
          ruleId: v.checkId,
          kind: 'pass',
          message: { text: v.target.message || 'Finding validated as a false positive' },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: v.target.file },
                region,
              },
            },
          ],
          suppressions: [
            {
              kind: 'external',
              justification: v.rationale,
            },
          ],
        } satisfies SarifResult;
      });
  }

  private buildCodeFlow(steps: DataFlowStep[]): SarifCodeFlow {
    return {
      threadFlows: [
        {
          locations: steps.map((step) => ({
            location: {
              physicalLocation: {
                artifactLocation: { uri: step.file },
                region: { startLine: step.lineNumber },
              },
              message: { text: step.label },
            },
          })),
        },
      ],
    };
  }
}
