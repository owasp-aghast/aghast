import { appendFileSync } from 'node:fs';
import { integrationResult } from './live-opencode-policy.mjs';

export default async function* reporter(events) {
  for await (const { type, data } of events) {
    if (type === 'test:stdout' || type === 'test:stderr') yield data.message;
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    if (data.details?.type === 'suite' || data.details?.error?.failureType === 'subtestsFailed') continue;
    const error = data.details?.error;
    const result = data.skip || data.todo
      ? { name: data.name, outcome: 'error', message: 'Live test was skipped or marked todo' }
      : integrationResult(data.name, error?.cause ?? error);
    appendFileSync(process.env.AGHAST_LIVE_TEST_REPORT, `${JSON.stringify(result)}\n`);
    yield `${result.outcome}: ${result.name}${result.message ? ` — ${result.message}` : ''}\n`;
  }
  appendFileSync(process.env.AGHAST_LIVE_TEST_REPORT, '{"complete":true}\n');
}
