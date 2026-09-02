# Changelog

All notable public changes to LSA Responsiveness Tracker are recorded here.

## [Unreleased]

No public changes yet.

## [1.0.0] - 2026-09-01

### Added

- Zero-dependency Node.js CLI for validating complete saved Google Ads Local Services conversation data and generating private HTML and JSON responsiveness reports.
- Versioned `lsa-responsiveness/v1` metric with explicit call, message, reply-speed, exclusion, and completeness rules.
- Portable, provider-neutral Agent Skill for connectors that can run raw GAQL and preserve complete row-level results.
- Minimal receipt-scoped skill installer for supported project and user locations.
- Private-by-default configuration and manifest examples plus a deterministic synthetic demo.
- Evidence-bounded documentation for the LSA transition into Google Ads Performance Max pay-per-lead campaigns.
- MIT license naming Alex Murtha as the copyright holder.

### Security and privacy

- No runtime dependencies, telemetry, or CLI network calls.
- Fail-closed validation for malformed, conflicting, partial, or incomplete connector data.
- Sanitized errors and restrictive local output permissions.
- Lead identifiers and message text disabled by default.

### Known limitations

- The release was verified locally on Node.js 24; Node.js 20 remains declared but not yet exercised in CI.
- Compatibility with a confirmed migrated Performance Max pay-per-lead account remains unverified until that account passes the live capability and schema probes.
- Saved-result completeness depends on truthful connector evidence and is not cryptographic proof.
- A same-user or privileged process can still create a final-pathname race at the accepted last-system-call boundary.
