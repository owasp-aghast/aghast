# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

Only the latest released version of aghast receives security updates.

## Reporting a Vulnerability

If you discover a security vulnerability in aghast, please report it responsibly using one of the following private channels:

- **GitHub Private Vulnerability Reporting** (preferred): Use the [Report a vulnerability](https://github.com/owasp-aghast/aghast/security/advisories/new) button on the Security tab of this repository.
- **Email**: Send details to **josh.grossman@owasp.org** or **avi.douglen@owasp.org** if you are unable to use GitHub's reporting feature.

Please include:

- A description of the vulnerability
- Steps to reproduce the issue
- Any relevant logs, screenshots, or proof of concept

We will acknowledge your report within 5 business days and aim to provide a fix or mitigation plan within 30 days, depending on severity.

Please do **not** open a public GitHub issue for security vulnerabilities.

## Security Fix Release Notes

When a release includes a fix for a disclosed vulnerability, the corresponding GitHub Release notes will explicitly identify the security fix.

Where applicable, the release notes will include the assigned CVE ID and a short description of the issue that was fixed.

## Scope

This policy covers the aghast CLI tool and its published npm package (`@owasp-aghast/aghast`). Security check definitions maintained in separate configuration repositories are out of scope for this policy.
