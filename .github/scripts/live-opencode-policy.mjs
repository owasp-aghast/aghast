// Availability is deliberately separate from assertion failures and harness errors.
export function unavailableError(message) {
  return /OpenCode session failed:|OpenCode AI returned no text response|OpenCode (?:authentication failed|rate limit reached)|OpenCode AI error \((?:APIError|ProviderAuthError|UnknownError)\)|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|\bfetch failed\b/i.test(message);
}

export function integrationResult(name, error) {
  if (!error) return { name, outcome: 'pass' };
  // Assertions always block, even if the response mentions a quota or network.
  const assertion = error.code === 'ERR_ASSERTION' || error.name === 'AssertionError';
  const message = error.message ?? String(error);
  return { name, outcome: assertion ? 'mismatch' : unavailableError(message) ? 'unavailable' : 'error', message };
}

export function regressionResult(result) {
  const name = `${result.codebase}/${result.checkId}`;
  if (result.error) {
    return { name, outcome: /Scan timed out/.test(result.error) ? 'unavailable' : 'error', message: result.error };
  }
  if (result.actualStatus === 'ERROR') {
    return { name, outcome: 'unavailable', message: 'Scan returned ERROR without a completed check status' };
  }
  if (!['PASS', 'FAIL', 'FLAG'].includes(result.actualStatus)) {
    return { name, outcome: 'error', message: `Unexpected check status: ${result.actualStatus}` };
  }
  const pass = result.statusPass && result.countPass && result.locationResults.every(location => location.type === 'matched');
  return { name, outcome: pass ? 'pass' : 'mismatch', message: pass ? undefined : 'Completed scan disagrees with expected status, findings, or locations' };
}

export function mergeResults(previous, current) {
  const merged = new Map(previous);
  for (const result of current) {
    const prior = merged.get(result.name);
    // An inconclusive retry cannot erase an observed regression. A later
    // completed pass for the SAME test/check can resolve it.
    if (result.outcome === 'unavailable' && prior && prior.outcome !== 'unavailable') continue;
    merged.set(result.name, result);
  }
  return merged;
}

export function verdict(results) {
  const values = [...results.values()];
  if (!values.length || values.some(result => ['mismatch', 'error'].includes(result.outcome))) return 'failure';
  return values.some(result => result.outcome === 'unavailable') ? 'warning' : 'pass';
}
