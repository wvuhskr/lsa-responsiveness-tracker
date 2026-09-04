# Connector contract

The connector may have any provider or tool name. It qualifies only when it can execute a raw GAQL query for one selected customer and return complete, row-level `local_services_lead_conversation` results in a supported envelope. Aggregated summaries cannot satisfy this contract.

## Migration boundary

The same contract applies after an LSA account becomes a Performance Max pay-per-lead campaign. Google currently exposes Local Services lead and conversation data through the Google Ads API, so the workflow is designed and expected to continue through the platform transition. Migrated-account support is not verified by the campaign label alone: run the live access and required-field probes against the migrated account, and stop if the resource, fields, permissions, or completion behavior no longer satisfy this contract.

## Required query fields

Select all six fields:

- `local_services_lead.id`
- `local_services_lead.lead_type`
- `local_services_lead_conversation.participant_type`
- `local_services_lead_conversation.conversation_channel`
- `local_services_lead_conversation.phone_call_details.call_duration_millis`
- `local_services_lead_conversation.event_date_time`

`local_services_lead_conversation.message_details.text` is optional and should be selected only when message-text output was explicitly enabled.

Use `FROM local_services_lead_conversation`. Apply the requested bounded date range in GAQL, but let the CLI enforce the account's time zone and reporting window.

Use this provider-neutral access probe after mapping the live tool's arguments:

```sql
SELECT customer.id FROM customer LIMIT 1
```

Then probe the LSA resource before requesting the full window:

```sql
SELECT
  local_services_lead.id,
  local_services_lead.lead_type,
  local_services_lead_conversation.participant_type,
  local_services_lead_conversation.conversation_channel,
  local_services_lead_conversation.phone_call_details.call_duration_millis,
  local_services_lead_conversation.event_date_time
FROM local_services_lead_conversation
LIMIT 1
```

For the reporting pull, use the same fields and a conservative cutoff at or before the requested window start. Add message text only after explicit opt-in. If a probe returns no rows and no usable column metadata, retry a wider valid period before concluding that the capability cannot be established; never invent activity.

## Supported response envelopes

- `columns-data`: the response root or its `result` object contains parallel `columns` and `data` arrays. Every data row must have the same width as `columns`.
- `google-ads-results`: the response root contains a `results` array of nested row objects.

Keep the returned `columns` exactly as supplied and map them dynamically. Do not assume column order. Each GAQL field may be returned with its selected snake-case spelling or the equivalent lower-camel-case path, such as `localServicesLead.id` or `localServicesLeadConversation.phoneCallDetails.callDurationMillis`. The CLI rejects missing, duplicate, or ambiguous required mappings.

An explicit root or supported `result` wrapper error, `isError: true`, `partial: true`, or truncation evidence makes the response unusable. An empty but structurally valid row set is supported. A response containing only aggregate columns is not.

## Completion manifest

Create a schema-version 1 manifest beside its response files. Record `source.customerId` from the actual query request (not merely the desired report label) and `source.selectedFields` as the exact list of GAQL fields selected. This evidence stays private. Choose exactly one completion method:

- `single-page-no-continuation`: exactly one page with `requestToken: null` and `nextPageToken: null`.
- `all-page-tokens-consumed`: one or more pages whose first request token is null, every nonfinal `nextPageToken` exactly equals the following page's `requestToken`, no continuation token repeats, and the final `nextPageToken` is null.
- `connector-complete-saved-result`: exactly one saved response and `savedResultWasComplete: true`.

The manifest `format` is `auto`, `columns-data`, or `google-ads-results`. Page paths are relative to the manifest directory, unique, and contained within it.

Response pagination evidence is checked at the response root and supported `result` wrapper, using `nextPageToken` or `next_page_token`. For a token chain, every present value must be null or a nonempty string and must exactly equal that page's declared `nextPageToken`; the final response may declare null but cannot point to another page. For single-page or connector-complete saved results, any nonempty response continuation token contradicts completeness. Missing response token metadata may rely on the already validated manifest assertion.

The manifest is a trust boundary: it records the collection process's completion claim; it cannot prove that a connector returned everything. In particular, `savedResultWasComplete: true` must reflect truthful connector evidence and is not cryptographic proof.

Example token-chain shape:

```json
{
  "schemaVersion": 1,
  "format": "auto",
  "source": { "customerId": "YOUR_CUSTOMER_ID" },
  "completion": { "method": "all-page-tokens-consumed" },
  "pages": [
    { "path": "page-1.json", "requestToken": null, "nextPageToken": "opaque-page-token" },
    { "path": "page-2.json", "requestToken": "opaque-page-token", "nextPageToken": null }
  ]
}
```

Replace `YOUR_CUSTOMER_ID` with the actual query customer in private storage. Treat page tokens as private even when the manifest itself contains no lead rows.

## Customer and field-selection evidence

`source` accepts only `customerId` and optional `selectedFields`. For native `results`, always include all required query fields in `selectedFields`; include message text only when actually selected after opt-in. This lets the CLI distinguish unselected fields from legitimate protobuf omissions and establish capability for a completed empty period. An empty native result requires both customer and complete selection evidence. A missing duration without selection evidence fails rather than being labeled a verified capability. Decimal-string int64 call durations are supported, subject to nonnegative safe-integer bounds.

Every returned `customer.id` or Local Services resource-name customer is compared with the configured customer. Contradictions fail even when the manifest claims a match. Columns envelopes may use snake-case or lower-camel-case resource-name paths. Without manifest source evidence, every row must carry a matching customer identity; empty pages require manifest evidence. Prefer selecting a customer identity or retaining returned resource names so accidental cross-account data can be detected directly.

Manifest evidence is the collector's assertion about the real request, not cryptographic proof. Do not reconstruct it by guessing after files have lost their provenance. Old manifests without source evidence must be re-collected or updated from retained request records. Validate the completed collection using `probe --config PATH`, which checks token chains and source evidence without writing outputs. Isolated `probe --input` remains a structural check and rejects continuation tokens.
