# Manual runbook

## 1. Resolve the CLI

When the skill was installed by the bundled installer, read `installation.json` in the skill directory and use its absolute `cliEntry`. For the skill bundled in this package, resolve `../../../bin/lsa-responsiveness.js` from the skill directory. Run commands with Node.js 20 or newer.

## 2. Prepare private storage

Create a directory outside tracked public files with mode `0700`. Write connector responses, pagination manifests, and the report config with mode `0600`. Keep customer IDs, page tokens, message text, lead rows, and output bundles there. Do not paste them into chat or installer receipts.

## 3. Collect and prove completeness

Follow the connector contract in order: discover a raw-GAQL capability, inspect its live schema, resolve the selected account, run a small access probe, run the field probe, and then collect the bounded result. Drain every pagination token or obtain explicit evidence that one saved result is complete. Write a manifest using the matching completion method.

Stop if authentication fails, the selected customer is unavailable, required fields are unsupported, the connector returns aggregates only, or completeness cannot be established. Do not estimate missing rows or metrics.

## 4. Validate saved responses

Run `probe` for each raw response before reporting:

```sh
node "$CLI_ENTRY" probe --input "$PRIVATE_INPUT/page-1.json" --format auto
```

Repeat `--input` to validate several responses together. Probe output contains only structural capability status, not row values, paths, IDs, or lead counts.

## 5. Generate the report

Create a private config from the package example, pointing each account to its completed manifest. Keep both privacy flags false unless the user deliberately opts in. Then run:

```sh
node "$CLI_ENTRY" report --config "$PRIVATE_INPUT/config.json" --output-dir "$PRIVATE_OUTPUT"
```

Open the generated `report/report.html`. Describe the result as a response-time and lead-status proxy, not Google's official LSA responsiveness figure. Message timing is precise when complete; phone connected status is approximate.

## Exit meanings and recovery

| Exit | Meaning | Recovery |
| --- | --- | --- |
| 0 | Success | Continue to the next step. |
| 1 | Unexpected internal failure | Stop, retain no pasted data, and retry with debug only in a private terminal. |
| 2 | Invalid command, config, or path policy | Stop and correct the CLI arguments, config, or safe destination. |
| 3 | Required connector capability is unsupported | Stop and use a different connector that returns complete row-level data. |
| 4 | Malformed, incomplete, conflicting, or connector-error data | Stop and re-export a complete clean response before retrying. |
| 5 | Output or transaction safety failure | Stop, inspect destination ownership and permissions, then choose a safe private destination. |

Never continue to `report` after a failed `probe`. Do not repair a failure by calculating a percentage yourself.

For exit `3`, choose a different connector with the missing row-level capability. For exit `4`, re-export the response from the connector before trying again.
