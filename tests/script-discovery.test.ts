/**
 * Unit tests for the script-discovery module.
 *
 * Covers output parsing across all formats, child-process execution, timeout
 * handling, path traversal rejection, and empty-output behavior.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, win32, posix } from 'node:path';
import {
  scriptDiscovery,
  parseScriptOutput,
  runScript,
  buildScriptEnv,
  isInsideRoot,
} from '../src/discoveries/script-discovery.js';
import type { SecurityCheck } from '../src/types.js';

let tmpRoot: string;
let repoDir: string;
let checkDir: string;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'aghast-script-discovery-'));
  repoDir = join(tmpRoot, 'repo');
  checkDir = join(repoDir, 'checks', 'demo');
  await mkdir(checkDir, { recursive: true });
});

after(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

function check(opts: Partial<SecurityCheck['checkTarget']> & { id?: string }): SecurityCheck {
  return {
    id: opts.id ?? 'demo-script-check',
    name: 'Demo Script Check',
    repositories: [],
    checkDir,
    instructionsFile: 'demo.md',
    checkTarget: {
      type: 'targeted',
      discovery: 'script',
      ...opts,
    } as SecurityCheck['checkTarget'],
  };
}

describe('parseScriptOutput: lines', () => {
  it('parses one path per non-empty line', () => {
    const out = parseScriptOutput('foo.js\nbar/baz.ts\n', 'lines');
    assert.equal(out.length, 2);
    assert.equal(out[0].file, 'foo.js');
    assert.equal(out[1].file, 'bar/baz.ts');
  });

  it('skips blank and comment lines', () => {
    const out = parseScriptOutput('# comment\n\nfile.ts\n  \n# another\nother.ts\n', 'lines');
    assert.equal(out.length, 2);
    assert.equal(out[0].file, 'file.ts');
    assert.equal(out[1].file, 'other.ts');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseScriptOutput('', 'lines'), []);
  });
});

describe('parseScriptOutput: json-array', () => {
  it('accepts an array of strings', () => {
    const out = parseScriptOutput(JSON.stringify(['a.js', 'b.js']), 'json-array');
    assert.equal(out.length, 2);
    assert.equal(out[0].file, 'a.js');
    assert.equal(out[1].file, 'b.js');
  });

  it('accepts an array of objects with file + lines + message', () => {
    const out = parseScriptOutput(
      JSON.stringify([
        { file: 'x.ts', startLine: 5, endLine: 7, message: 'hi', snippet: 'snippet text' },
      ]),
      'json-array',
    );
    assert.equal(out[0].file, 'x.ts');
    assert.equal(out[0].startLine, 5);
    assert.equal(out[0].endLine, 7);
    assert.equal(out[0].message, 'hi');
    assert.equal(out[0].snippet, 'snippet text');
  });

  it('rejects a non-array root', () => {
    assert.throws(
      () => parseScriptOutput('{"a":1}', 'json-array'),
      /expects a JSON array/,
    );
  });

  it('rejects malformed JSON', () => {
    assert.throws(
      () => parseScriptOutput('{not json', 'json-array'),
      /not valid JSON/,
    );
  });

  it('rejects entries without a "file" string', () => {
    assert.throws(
      () => parseScriptOutput(JSON.stringify([{ startLine: 1 }]), 'json-array'),
      /must be a non-empty string/,
    );
  });

  it('rejects entries that are arrays/null', () => {
    assert.throws(
      () => parseScriptOutput(JSON.stringify([null]), 'json-array'),
      /must be a string or object/,
    );
    assert.throws(
      () => parseScriptOutput(JSON.stringify([[1, 2]]), 'json-array'),
      /must be a string or object/,
    );
  });

  it('rejects negative line numbers', () => {
    assert.throws(
      () => parseScriptOutput(JSON.stringify([{ file: 'a.js', startLine: -1 }]), 'json-array'),
      /non-negative number/,
    );
  });
});

describe('parseScriptOutput: json-object', () => {
  it('accepts {targets: [...]}', () => {
    const out = parseScriptOutput(
      JSON.stringify({ targets: ['a.js', { file: 'b.js' }] }),
      'json-object',
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].file, 'a.js');
    assert.equal(out[1].file, 'b.js');
  });

  it('rejects missing targets array', () => {
    assert.throws(
      () => parseScriptOutput(JSON.stringify({ other: [] }), 'json-object'),
      /"targets" array/,
    );
  });

  it('rejects an array root', () => {
    assert.throws(
      () => parseScriptOutput(JSON.stringify([1, 2, 3]), 'json-object'),
      /expects a JSON object/,
    );
  });
});

describe('runScript: child process control', () => {
  it('captures stdout and exit code 0', async () => {
    const result = await runScript({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hello\\n")'],
      cwd: repoDir,
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello\n');
  });

  it('captures non-zero exit code', async () => {
    const result = await runScript({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      cwd: repoDir,
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 7);
  });

  it('rejects after timeout when the script hangs', async () => {
    await assert.rejects(
      runScript({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: repoDir,
        timeoutMs: 200,
      }),
      /timed out/,
    );
  });
});

describe('scriptDiscovery.discover', () => {
  it('parses lines output and returns DiscoveredTarget[]', async () => {
    const scriptPath = join(checkDir, 'list.cjs');
    await writeFile(
      scriptPath,
      `console.log("src/a.ts");\nconsole.log("src/b.ts");\n`,
    );

    const targets = await scriptDiscovery.discover(
      check({
        script: 'list.cjs',
        scriptType: 'node',
        outputFormat: 'lines',
      }),
      repoDir,
    );

    assert.equal(targets.length, 2);
    assert.equal(targets[0].file, 'src/a.ts');
    assert.equal(targets[0].startLine, 1);
    assert.equal(targets[0].endLine, 1);
    assert.match(targets[0].label, /script-target 1\/2/);
    assert.ok(targets[0].promptEnrichment?.includes('TARGET LOCATION'));
  });

  it('parses json-array output with line numbers', async () => {
    const scriptPath = join(checkDir, 'targets.cjs');
    await writeFile(
      scriptPath,
      `process.stdout.write(JSON.stringify([{ file: "src/x.ts", startLine: 10, endLine: 20, message: "found" }]));`,
    );

    const targets = await scriptDiscovery.discover(
      check({
        script: 'targets.cjs',
        scriptType: 'node',
        outputFormat: 'json-array',
      }),
      repoDir,
    );

    assert.equal(targets.length, 1);
    assert.equal(targets[0].file, 'src/x.ts');
    assert.equal(targets[0].startLine, 10);
    assert.equal(targets[0].endLine, 20);
    assert.equal(targets[0].message, 'found');
  });

  it('parses json-object output', async () => {
    const scriptPath = join(checkDir, 'object.cjs');
    await writeFile(
      scriptPath,
      `process.stdout.write(JSON.stringify({ targets: [{ file: "lib/c.ts" }] }));`,
    );

    const targets = await scriptDiscovery.discover(
      check({
        script: 'object.cjs',
        scriptType: 'node',
        outputFormat: 'json-object',
      }),
      repoDir,
    );

    assert.equal(targets.length, 1);
    assert.equal(targets[0].file, 'lib/c.ts');
  });

  it('returns empty array on empty stdout', async () => {
    const scriptPath = join(checkDir, 'empty.cjs');
    await writeFile(scriptPath, `// nothing\n`);

    const targets = await scriptDiscovery.discover(
      check({
        script: 'empty.cjs',
        scriptType: 'node',
        outputFormat: 'lines',
      }),
      repoDir,
    );
    assert.deepEqual(targets, []);
  });

  it('applies maxTargets limit', async () => {
    const scriptPath = join(checkDir, 'many.cjs');
    await writeFile(
      scriptPath,
      `for (let i = 0; i < 50; i++) console.log("file-" + i + ".ts");`,
    );

    const targets = await scriptDiscovery.discover(
      check({
        script: 'many.cjs',
        scriptType: 'node',
        outputFormat: 'lines',
        maxTargets: 5,
      }),
      repoDir,
    );
    assert.equal(targets.length, 5);
    assert.equal(targets[0].file, 'file-0.ts');
    assert.equal(targets[4].file, 'file-4.ts');
  });

  it('rejects path traversal in script field (../escape)', async () => {
    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: '../../etc/passwd',
          scriptType: 'node',
          outputFormat: 'lines',
        }),
        repoDir,
      ),
      /resolves outside/,
    );
  });

  it('rejects absolute script path', async () => {
    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: resolve(tmpRoot, 'evil.cjs'),
          scriptType: 'node',
          outputFormat: 'lines',
        }),
        repoDir,
      ),
      /must be a relative path/,
    );
  });

  it('rejects path traversal in cwd', async () => {
    const scriptPath = join(checkDir, 'list-cwd.cjs');
    await writeFile(scriptPath, `console.log("a.ts");`);

    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: 'list-cwd.cjs',
          scriptType: 'node',
          outputFormat: 'lines',
          cwd: '../escape',
        }),
        repoDir,
      ),
      /resolves outside/,
    );
  });

  it('rejects when script does not exist', async () => {
    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: 'missing-script.cjs',
          scriptType: 'node',
          outputFormat: 'lines',
        }),
        repoDir,
      ),
      /not found or unreadable/,
    );
  });

  it('rejects when scriptType is missing', async () => {
    const scriptPath = join(checkDir, 'noop.cjs');
    await writeFile(scriptPath, `console.log("a.ts");`);
    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: 'noop.cjs',
          outputFormat: 'lines',
        }),
        repoDir,
      ),
      /scriptType/,
    );
  });

  it('rejects when outputFormat is missing', async () => {
    const scriptPath = join(checkDir, 'noop2.cjs');
    await writeFile(scriptPath, `console.log("a.ts");`);
    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: 'noop2.cjs',
          scriptType: 'node',
        }),
        repoDir,
      ),
      /outputFormat/,
    );
  });

  it('rejects when script exits non-zero', async () => {
    const scriptPath = join(checkDir, 'fail.cjs');
    await writeFile(
      scriptPath,
      `process.stderr.write("boom\\n"); process.exit(3);`,
    );
    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: 'fail.cjs',
          scriptType: 'node',
          outputFormat: 'lines',
        }),
        repoDir,
      ),
      /exited with code=3/,
    );
  });

  it('enforces per-check timeout', async () => {
    const scriptPath = join(checkDir, 'hang.cjs');
    await writeFile(
      scriptPath,
      `setInterval(() => {}, 1000);`,
    );

    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: 'hang.cjs',
          scriptType: 'node',
          outputFormat: 'lines',
          timeoutMs: 200,
        }),
        repoDir,
      ),
      /timed out/,
    );
  });

  it('rejects bash on Windows', async () => {
    if (process.platform !== 'win32') {
      // Skip silently — only meaningful on Windows
      return;
    }
    const scriptPath = join(checkDir, 'bash.sh');
    await writeFile(scriptPath, `echo "hi"`);
    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: 'bash.sh',
          scriptType: 'bash',
          outputFormat: 'lines',
        }),
        repoDir,
      ),
      /not supported on Windows/,
    );
  });

});

// ─── New tests for security hardening ────────────────────────────────────────

describe('buildScriptEnv (env sanitization)', () => {
  it('strips ANTHROPIC_API_KEY and GITHUB_TOKEN', () => {
    const env = buildScriptEnv({
      ANTHROPIC_API_KEY: 'sk-leak',
      GITHUB_TOKEN: 'ghs_leak',
      OPENAI_API_KEY: 'sk-leak2',
      AGHAST_DEBUG: 'true',
      PATH: '/usr/bin',
      HOME: '/home/u',
    });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.AGHAST_DEBUG, undefined);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/u');
  });

  it('strips arbitrary *_KEY / *_TOKEN / *_SECRET / *_PASSWORD vars', () => {
    const env = buildScriptEnv({
      MY_API_KEY: 'leak',
      SOME_TOKEN: 'leak',
      DB_PASSWORD: 'leak',
      WEBHOOK_SECRET: 'leak',
      DB_PASSWD: 'leak',
      PATH: '/usr/bin',
    });
    assert.equal(env.MY_API_KEY, undefined);
    assert.equal(env.SOME_TOKEN, undefined);
    assert.equal(env.DB_PASSWORD, undefined);
    assert.equal(env.WEBHOOK_SECRET, undefined);
    assert.equal(env.DB_PASSWD, undefined);
    assert.equal(env.PATH, '/usr/bin');
  });

  it('keeps only allow-listed env vars', () => {
    const env = buildScriptEnv({
      PATH: '/usr/bin',
      RANDOM_VAR: 'should-be-dropped',
      LANG: 'en_US.UTF-8',
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.LANG, 'en_US.UTF-8');
    assert.equal(env.RANDOM_VAR, undefined);
  });

  it('matches allow-list case-insensitively (Windows-style Path/SystemRoot survive)', () => {
    // On Windows, `process.env` enumerates with original casing such as
    // `Path`, `SystemRoot`, `ProgramFiles`. A strict `Set.has` would drop
    // those; the allow-list must match case-insensitively.
    const env = buildScriptEnv({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      // sanity: still rejects unknown vars regardless of case
      RandomVar: 'drop-me',
    });
    assert.equal(env.Path, 'C:\\Windows\\System32');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.ProgramFiles, 'C:\\Program Files');
    assert.equal(env.RandomVar, undefined);
  });
});

describe('runScript: stdout overflow', () => {
  it('rejects when stdout exceeds the 8 MiB cap', async () => {
    // 9 MiB of "x" — comfortably exceeds MAX_STDOUT_BYTES = 8 MiB.
    await assert.rejects(
      runScript({
        command: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(9 * 1024 * 1024))"],
        cwd: repoDir,
        timeoutMs: 30_000,
      }),
      /stdout exceeded/,
    );
  });
});

describe('scriptDiscovery: emitted file path validation', () => {
  it('rejects script-emitted absolute file paths', async () => {
    const scriptPath = join(checkDir, 'abs.cjs');
    await writeFile(
      scriptPath,
      `process.stdout.write(JSON.stringify([{ file: "/etc/passwd" }]));`,
    );
    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: 'abs.cjs',
          scriptType: 'node',
          outputFormat: 'json-array',
        }),
        repoDir,
      ),
      /must be relative/,
    );
  });

  it('rejects script-emitted file paths that traverse via ".."', async () => {
    const scriptPath = join(checkDir, 'traverse.cjs');
    await writeFile(
      scriptPath,
      `process.stdout.write(JSON.stringify([{ file: "../../etc/passwd" }]));`,
    );
    await assert.rejects(
      scriptDiscovery.discover(
        check({
          script: 'traverse.cjs',
          scriptType: 'node',
          outputFormat: 'json-array',
        }),
        repoDir,
      ),
      /escapes the repository root/,
    );
  });

  it('normalizes startLine=0 to 1 (1-based line numbering)', async () => {
    const scriptPath = join(checkDir, 'zero.cjs');
    await writeFile(
      scriptPath,
      `process.stdout.write(JSON.stringify([{ file: "src/x.ts", startLine: 0, endLine: 0 }]));`,
    );
    const targets = await scriptDiscovery.discover(
      check({
        script: 'zero.cjs',
        scriptType: 'node',
        outputFormat: 'json-array',
      }),
      repoDir,
    );
    assert.equal(targets[0].startLine, 1);
    assert.equal(targets[0].endLine, 1);
  });
});

describe('scriptDiscovery: symlink escape', () => {
  it('rejects when the script is a symlink whose realpath escapes the check folder', async (t) => {
    if (process.platform === 'win32') {
      // Symlink creation on Windows requires elevated privileges; skip.
      t.skip('symlink test skipped on Windows');
      return;
    }
    // Create a target file outside the repo entirely.
    const outsideDir = await mkdtemp(join(tmpdir(), 'aghast-outside-'));
    try {
      const outsideScript = join(outsideDir, 'evil.cjs');
      await writeFile(outsideScript, `console.log("pwned.ts");`);
      // Symlink inside checkDir → outside file
      const linkPath = join(checkDir, 'evil-link.cjs');
      await symlink(outsideScript, linkPath);

      await assert.rejects(
        scriptDiscovery.discover(
          check({
            script: 'evil-link.cjs',
            scriptType: 'node',
            outputFormat: 'lines',
          }),
          repoDir,
        ),
        /resolves outside/,
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('parseScriptOutput: JSON cap (defence in depth)', () => {
  it('caps json-array at MAX_JSON_TARGETS', () => {
    const big = JSON.stringify(Array.from({ length: 100_001 }, (_, i) => `f${i}.ts`));
    const out = parseScriptOutput(big, 'json-array');
    assert.equal(out.length, 100_000);
  });
});

describe('isInsideRoot', () => {
  const win = { relative: win32.relative, isAbsolute: win32.isAbsolute };

  it('accepts a path inside the root', () => {
    assert.equal(isInsideRoot('/repo', '/repo/checks/demo', posix), true);
  });

  it('rejects a path escaping via ..', () => {
    assert.equal(isInsideRoot('/repo', '/elsewhere/checks', posix), false);
  });

  it('rejects a Windows path on a different drive', () => {
    // The bug this guards. Across drives `relative()` returns an ABSOLUTE path
    // rather than a '..' chain, so a check that only looks for '..' concludes
    // "inside" and the caller then rejects a perfectly valid layout. Asserting
    // the premise first makes the test self-explanatory when it fails.
    assert.equal(win32.relative('C:\\repo', 'D:\\checks\\demo').startsWith('..'), false);
    assert.equal(isInsideRoot('C:\\repo', 'D:\\checks\\demo', win), false);
  });

  it('accepts a Windows path on the same drive', () => {
    assert.equal(isInsideRoot('C:\\repo', 'C:\\repo\\checks', win), true);
  });
});

describe('scriptDiscovery.discover: check folder outside the repository', () => {
  // Every other test in this file puts the check folder INSIDE the repo, so the
  // outside-repo branch went unexercised — and a bug in it reached CI.
  //
  // The branch guards a defence-in-depth assertion that the script also lives
  // under the repo root. That assertion must only apply when the check folder
  // is itself inside the repo; otherwise a perfectly valid layout is rejected.
  //
  // Two real layouts take this branch:
  //   1. Local dev, where checks-config/ sits beside the target repo (this test).
  //   2. Windows with the repo and the config dir on different drives, where
  //      `relative()` returns an absolute path instead of a `..` chain. That is
  //      not reproducible cross-platform, but it resolves through this same
  //      branch, so covering the layout here guards both.
  it('runs a script whose check folder is a sibling of the repo', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'aghast-outside-checks-'));
    try {
      const outsideCheckDir = join(outsideRoot, 'checks', 'demo');
      await mkdir(outsideCheckDir, { recursive: true });
      await writeFile(
        join(outsideCheckDir, 'list.cjs'),
        `console.log("src/outside.ts");\n`,
      );

      const targets = await scriptDiscovery.discover(
        {
          id: 'outside-check',
          name: 'Outside Check',
          repositories: [],
          checkDir: outsideCheckDir,
          instructionsFile: 'demo.md',
          checkTarget: {
            type: 'targeted',
            discovery: 'script',
            script: 'list.cjs',
            scriptType: 'node',
            outputFormat: 'lines',
          },
        } as SecurityCheck,
        repoDir,
      );

      assert.equal(targets.length, 1);
      assert.equal(targets[0].file, 'src/outside.ts');
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
