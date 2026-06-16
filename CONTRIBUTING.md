# Contributing to AGHAST

Thank you for your interest in AGHAST! This document explains how you can contribute.

## Bug Reports and Feature Requests

We welcome bug reports and feature requests via [GitHub Issues](https://github.com/owasp-aghast/aghast/issues).

When filing a bug report, please include:

- The version of aghast you are using (`aghast --version`)
- Your Node.js version (`node --version`)
- Your operating system and version
- Steps to reproduce the issue
- Expected vs. actual behavior
- Any relevant log output (use `--debug` for verbose output)

For feature requests, describe the use case and why the feature would be valuable.

## Pull Requests

We are not currently accepting pull requests. If you have an idea for a change, please open an issue first to discuss it.

## Security Vulnerabilities

Please do **not** report security vulnerabilities via GitHub Issues. See our [Security Policy](SECURITY.md) for responsible disclosure instructions.

## Development

If you are working on aghast itself, see the [Development guide](docs/development.md) for setup, building, and testing instructions.

### Testing Policy

All new functionality must include tests. Specifically:

- **CLI-level integration tests** in `tests/cli-mock-mode.test.ts` that spawn the real CLI process with `AGHAST_MOCK_AI=true`. These exercise the full pipeline end-to-end.
- Include tests for **PASS**, **FAIL**, and **ERROR** scenarios as appropriate.
- Tests use `node:test` and `node:assert` (Node.js built-in) — no external test frameworks.
- The agent provider must be mocked/stubbed in all tests — tests must pass without `ANTHROPIC_API_KEY` set.

Run the test suite with:

```bash
npm test
```

### Coding Standards

- TypeScript with strict mode enabled
- ESLint enforced (`npm run lint`)
- Error codes from `src/error-codes.ts` for all CLI error paths
- Color output via `src/colors.ts` helpers, never raw ANSI codes

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## License

By contributing to aghast, you agree that your contributions will be licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
