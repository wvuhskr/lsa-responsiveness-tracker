# LSA-to-Performance-Max compatibility

Status as of 2026-09-01: this release is designed for Google's LSA-to-Google-Ads transition and is expected to continue working after migration, but confirmed migrated-account compatibility has not yet been directly validated.

## What Google has confirmed

Google is moving Local Services Ads into Google Ads as specialized Performance Max campaigns with pay-per-lead goals. Google says:

- the standalone Local Services Ads dashboard will be replaced by Google Ads for migrated accounts;
- past customer lead history and conversations will transfer to the Google Ads Leads page;
- historical campaign performance reports will not transfer; and
- the Google Ads API supports identifying Local Services-enabled Performance Max campaigns.

Google's current API documentation also lists `local_services_lead` and `local_services_lead_conversation` as read-only Local Services reporting resources.

## Why this tracker is positioned for the transition

The tracker does not scrape or automate the standalone LSA dashboard. Its metric is calculated from complete, row-level `local_services_lead_conversation` events returned through the Google Ads API by a compatible connector.

That places the tracker on the Google Ads API reporting surface Google currently documents for Local Services, rather than the user interface being retired. If a migrated account continues returning the required events with their current meanings, the `lsa-responsiveness/v1` metric does not need to change.

## What has not been proven

Google has not published a guarantee that every required resource, field, permission, or response behavior will remain identical for migrated accounts. This release has not yet completed a live query and schema comparison against an account confirmed to have migrated to Performance Max pay-per-lead.

For that reason, the supported claim is "designed for the transition and expected to continue working," not "guaranteed to be unaffected."

## How the release fails safely

When the bundled Agent Skill is used, it:

1. discovers the connector by raw-GAQL capability;
2. inspects the live tool schema instead of guessing argument names;
3. runs account-access and required-field probes;
4. drains pagination and records completion evidence; and
5. invokes the CLI only after the saved response passes structural validation.

The CLI refuses malformed, partial, unsupported, or incomplete data. A migration-related resource or field change therefore stops the workflow instead of producing a fallback percentage from weaker evidence.

## What to do after an account migrates

1. Preserve any historical LSA performance reports needed for comparison because Google says those reports will not transfer.
2. Run the Agent Skill's live access and required-field probes against the migrated account.
3. Run the CLI `probe` command on the complete saved result.
4. Generate a report only after both checks pass.
5. If a required resource or field changed, update and retest the connector contract before treating the migrated account as supported.

Passing those checks verifies that account, connector, and observed schema at that time. It is not a permanent guarantee for every provider or future Google Ads API version.

## Official sources

- [Google Ads Help: Local Services Ads transition to Performance Max campaigns with pay-per-lead goals](https://support.google.com/google-ads/answer/17213585?hl=en)
- [Google Ads API: Local Services campaigns](https://developers.google.com/google-ads/api/docs/campaigns/local-service-campaigns?hl=en)
- [Google Ads API field reference: `local_services_lead_conversation`](https://developers.google.com/google-ads/api/fields/v22/local_services_lead_conversation)
- [Google Ads API field reference: `local_services_lead`](https://developers.google.com/google-ads/api/fields/v22/local_services_lead)
