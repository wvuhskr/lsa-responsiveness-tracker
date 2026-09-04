---
name: lsa-responsiveness-tracker
description: Use when collecting complete Local Services Ads conversation data through a raw-GAQL connector and generating a private responsiveness report.
---

# LSA Responsiveness Tracker

Use the packaged CLI as the only authority for ingestion, metrics, and report generation. The result is a response-time and lead-status proxy, not Google's official LSA responsiveness figure. Message timing is precise when the required events are complete; phone connected status is approximate.

Read [the connector contract](references/connector-contract.md) before collecting data. Use [the runbook](references/runbook.md) for private files, CLI commands, exit meanings, and recovery.

## Workflow

1. Discover a live connector by capability, not by provider or tool name. It must execute raw GAQL against `local_services_lead_conversation`, accept a selected customer, and return complete rows with pagination evidence. Aggregation-only connectors are unsupported.
2. Inspect the live tool schema. Identify its query and customer arguments, optional manager or login-customer argument, and pagination arguments. Do not guess argument names.
3. List or identify accessible accounts if the connector supports account discovery. Otherwise ask the user for the customer ID and, only when required by the schema, the login-customer ID. Never place identifiers or credentials in this skill, tracked files, or chat output.
4. Run a small access probe for the selected account. Stop and give recovery guidance if authentication, customer selection, resource access, or pagination is unavailable.
5. Run a required-resource and field probe using the contract's exact fields. Request the optional message-text field only when the user explicitly opted in. Stop if the result is aggregation-only, lacks required returned columns, reports an error, is partial, or is incomplete.
6. Run the bounded reporting query and drain every page, preserving the returned column metadata and page-token chain. A connector-complete saved result is acceptable only with explicit, truthful completion evidence. Save raw responses and the manifest directly to private local files; never paste real rows into chat.
7. Record the actual query customer and selected fields in the private manifest's `source` evidence. Create the private config and invoke `probe --config PATH` to validate all saved pages together, including account binding and consumed continuation tokens. Do not continue after a nonzero exit; follow the runbook's recovery action. Do not use isolated per-page probes as the completion gate for paginated results.
8. Invoke the `report` CLI command with the private config and a private output directory. Present the generated report and repeat the proxy, message, and phone caveats.

Never calculate a fallback percentage or duplicate the metric formulas. Never summarize private row values in chat. Never expose credentials, access tokens, customer identifiers, message text, or connector input/output filenames in chat. Installation receipts may contain only the package and CLI paths defined by the installer, never connector data.

Treat an LSA account migrated to a Performance Max pay-per-lead campaign as unverified until that account passes the live access probe, required-field probe, pagination checks, and CLI probe. The tool is designed for the transition because it reads Google Ads API lead-conversation resources rather than the retiring standalone dashboard, but do not promise unchanged post-migration compatibility without that direct validation.
