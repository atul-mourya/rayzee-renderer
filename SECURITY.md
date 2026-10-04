# Security Policy

Thank you for helping keep Rayzee and its users safe.

## Supported Versions

Security fixes are applied to the latest release of the `rayzee` engine package on npm. Older versions are not patched — please upgrade to the latest release to receive fixes.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest release | :white_check_mark: |
| Older releases | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, report them privately using one of the following channels:

1. **Preferred:** [GitHub Private Vulnerability Reporting](https://github.com/atul-mourya/rayzee-renderer/security/advisories/new) — opens a private advisory visible only to maintainers.
2. **Email:** [atul.mourya@gmail.com](mailto:atul.mourya@gmail.com) with the subject line `[SECURITY] Rayzee - <short summary>`.

Please include as much of the following as you can:

- A description of the issue and the kind of impact you expect (e.g. RCE, XSS, denial of service, data exposure, supply-chain risk).
- Steps to reproduce, including a minimal proof-of-concept if possible.
- Affected version(s), browser/OS, and WebGPU adapter where relevant.
- Any suggested mitigation or fix.

You should receive an initial acknowledgement within **72 hours**. We aim to provide a triage assessment within **7 days** and, where applicable, a fix or mitigation within **30 days** of confirmation. Timelines may shift for complex issues — we will keep you updated.

## Scope

In scope:

- The `rayzee` rendering engine package and its public API.
- The companion app under `app/` (build, runtime, and bundled assets).
- Repository workflows, release pipeline, and published artifacts on npm.

Out of scope:

- Vulnerabilities in third-party dependencies that are already tracked upstream — please report those to the upstream project. We will still update the affected dependency once a fix is available.
- Issues that require a malicious local user, a compromised browser, or non-default browser flags.
- Self-XSS, missing security headers on demo deployments, or denial of service via deliberately oversized scene assets.

## Disclosure

We follow coordinated disclosure. Once a fix is released, we will credit the reporter (unless anonymity is requested) in the release notes and any associated GitHub Security Advisory. Please do not publicly disclose the vulnerability until a fix has shipped or 90 days have passed, whichever comes first.

## Security Best Practices for Users

- Always use the latest published version of the `rayzee` package.
- Treat user-supplied scene files (GLB/GLTF, HDRI, textures) as untrusted input — validate sources before loading.
- Serve the app over HTTPS and configure a Content Security Policy appropriate for your deployment.
