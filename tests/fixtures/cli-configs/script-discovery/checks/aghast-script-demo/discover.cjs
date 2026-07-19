// Script-discovery fixture: emits 3 file paths from the test git-repo fixture.
// One path per line — outputFormat: "lines" in the check definition.
//
// NOTE: We intentionally emit duplicates here. Unlike SARIF discovery (which
// dedupes), script discovery treats every emitted target as a deliberate
// instruction from the script author — if you want dedup, dedupe in the
// script. The 3 duplicates exist so the test verifies targetsAnalyzed === 3.
process.stdout.write('src/example.ts\n');
process.stdout.write('src/example.ts\n');
process.stdout.write('src/example.ts\n');
