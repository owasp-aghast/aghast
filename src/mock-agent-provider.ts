/**
 * Lightweight mock agent provider for CLI `AGHAST_MOCK_AI` mode.
 *
 * Returns a fixed raw response without calling any AI API.
 * This is shipped with the package (unlike the full test mock in tests/mocks/).
 */

import type { AgentProvider, AgentResponse, ProviderConfig, TokenUsage } from './types.js';

export class MockAgentProvider implements AgentProvider {
  private rawResponse: string;
  private model: string = 'mock';
  private tokenUsage: TokenUsage | undefined;
  /** Remaining calls that should fail before the mock starts succeeding. */
  private failuresRemaining: number;

  constructor(options: { rawResponse: string; tokenUsage?: TokenUsage; failTimes?: number }) {
    this.rawResponse = options.rawResponse;
    this.tokenUsage = options.tokenUsage;
    this.failuresRemaining = options.failTimes ?? 0;
  }

  async initialize(_config: ProviderConfig): Promise<void> {
    // No-op
  }

  async executeCheck(
    _instructions: string,
    _repositoryPath: string,
    _logPrefix?: string,
    _options?: { maxTurns?: number },
  ): Promise<AgentResponse> {
    // Test hook: fail the first N calls with a retryable error, then succeed.
    // Lets CLI-level tests prove that a transient provider failure is retried
    // and the scan still completes, which cannot be observed from unit tests of
    // withRetry alone. The error carries a 503 status so it is classified
    // retryable by the real classifier rather than a test-only special case.
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      const err = Object.assign(
        new Error('Mock transient provider failure (AGHAST_MOCK_FAIL_TIMES)'),
        { status: 503 },
      );
      throw err;
    }

    const response: AgentResponse = {
      raw: this.rawResponse,
      parsed: undefined,
    };
    if (this.tokenUsage) {
      response.tokenUsage = { ...this.tokenUsage };
    }
    return response;
  }

  async validateConfig(): Promise<boolean> {
    return true;
  }

  getModelName(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

}
