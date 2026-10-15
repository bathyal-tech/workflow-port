# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

Only the latest GitHub Release is supported. Upgrade to it before reporting.

## Reporting a vulnerability

**Do not open a public issue.** Use
[GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repo — the report goes only to maintainers.

Please include:

- What you think is vulnerable (converter, CLI, release pipeline, binaries)
- Steps to reproduce, ideally with a minimal workflow fixture
- What an attacker could achieve and what they would need (local access?
  a malicious workflow file? a compromised dependency?)

We will acknowledge within a few days, keep the discussion private until a fix
is released, and credit you in the advisory unless you prefer otherwise.

## Supply-chain notes for the security-minded

- Release binaries are built in GitHub Actions from tagged sources and carry
  SLSA build-provenance attestations — verify with
  `gh attestation verify dist/wfport-* --owner bathyal-tech` semantics
  (see [GitHub artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)).
- CI pins third-party Actions to major versions, runs with least-privilege
  tokens, and Dependabot keeps them updated weekly.
- [OpenSSF Scorecard](https://scorecard.dev/) runs weekly against this repo;
  findings land in the Security tab.
