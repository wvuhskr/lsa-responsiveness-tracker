# Security policy

## Supported version

Security fixes are evaluated for the latest published release. The current supported release is `1.0.0`.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability or privacy exposure. Use GitHub private vulnerability reporting for this repository through **Security > Advisories > Report a vulnerability**.

If private vulnerability reporting is unavailable, open a public issue containing only a request for a private contact channel. Do not describe the vulnerability or attach diagnostic files there.

Useful reports identify the affected version, the security boundary involved, safe reproduction steps using synthetic data, and the expected impact. Reports are reviewed on a best-effort basis; no response-time guarantee is offered.

## Never include private advertising data

Do not submit or attach:

- Google Ads customer or manager account IDs;
- lead IDs, phone numbers, names, addresses, or message text;
- credentials, access tokens, cookies, page tokens, or service-account files;
- raw connector responses, manifests, reports, screenshots, or terminal output containing private data; or
- private repository paths, hostnames, or client names.

Use the bundled synthetic fixtures to reproduce a problem. If a report cannot be reproduced without private data, state that privately and wait for handling instructions before sharing anything.

## Scope

Security reports may cover private-data exposure, validation bypasses that could produce misleading metrics, unsafe file handling, installer boundary failures, or another defect with a concrete confidentiality, integrity, or availability impact. General usage questions and feature requests belong in GitHub Issues and must also use synthetic examples only.
