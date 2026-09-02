# LSA Responsiveness Tracker

See whether your team is actually answering Local Services Ads leads, not just how many leads Google delivered.

LSA reporting can tell a marketer that a call or message arrived. It is much less useful for answering the operational questions that come next: Did the call connect? Did anyone reply to the message? How long did the reply take? Are recent leads still waiting?

LSA Responsiveness Tracker turns raw Google Ads LSA conversation events into a private, auditable report for those questions. It gives agencies and in-house marketers one consistent view of call connection, message follow-up, reply speed, and recent unanswered leads across the accounts they manage.

This is a response-time and lead-status proxy, not Google's official LSA responsiveness figure. Google does not publish the exact formula. The tracker makes its own formula explicit so every result can be understood and reproduced.

Current release: `1.0.0`. The documented Node.js 20 and confirmed migrated-account validation gaps remain open and are listed under Known limitations.

## Why marketers use it

- Find lead-handling gaps that campaign-level lead counts cannot show.
- Separate media delivery from the operational follow-up that happens after a lead arrives.
- Compare call and message handling without rebuilding the logic in a spreadsheet every week.
- Give account teams and operators exact counts behind every percentage.
- Track whether responsiveness is improving when optional history is enabled.
- Keep lead-level source data and reports on the local machine by default.

It is useful for weekly account reviews, agency client reporting, dispatch or call-center follow-up checks, and investigating whether lead handling is contributing to a gap between leads and conversations.

## What the report answers

| Marketer's question | Report signal |
| --- | --- |
| Are inbound phone leads connecting? | Connected-call proxy, total inbound calls, and exact connected/total counts |
| Are message leads being answered? | Message reply rate and exact replied/eligible counts |
| How quickly does the team respond? | Median reply time, reply-speed buckets, and replies within 24 hours |
| Which recent messages still need attention? | Recent unanswered count and an optional private follow-up CSV |
| Is handling improving? | Aggregate responsiveness trend when compatible history is enabled |
| Can I trust the denominator? | Completion evidence, excluded lead types, and incomplete-window diagnostics |

The result is a light-mode static HTML report that can be opened locally. Machine-readable JSON is included for teams that want to feed the same validated metrics into another private workflow.

## How it works

`Raw LSA conversation events -> completeness checks -> frozen metric -> private HTML and JSON report`

1. A compatible Google Ads connector, whether exposed through Model Context Protocol (MCP) or another tool, runs a raw Google Ads Query Language (GAQL) query for `local_services_lead_conversation`.
2. The complete row-level response and pagination evidence are saved to private local files.
3. The Node.js CLI validates the envelope, returned columns, time window, account boundary, and completion manifest before calculating anything.
4. The CLI applies the versioned `lsa-responsiveness/v1` calculation rules and writes the report locally.

The CLI is the single calculation authority. The portable Agent Skill can guide data collection and invoke the CLI, but it does not duplicate or improvise the formulas.

## Designed for the LSA-to-Google-Ads transition

Google is moving Local Services Ads into Google Ads as specialized Performance Max campaigns with pay-per-lead goals. This tracker does not read the retiring standalone LSA dashboard. It reads the Google Ads API's `local_services_lead` and `local_services_lead_conversation` reporting resources, which Google currently documents alongside Local Services-enabled Performance Max campaigns.

That architecture makes the tracker well-positioned and expected to continue working after an account migrates. It is not a guarantee of unchanged compatibility. Google has not promised that every required field, permission, or response behavior will remain identical, and this release has not yet been validated against a confirmed migrated account.

When the bundled Agent Skill is used, it rechecks live connector access and the required fields before collecting a report. The CLI separately validates the saved response and stops without producing metrics when required rows, fields, or completeness evidence are missing. A migrated account becomes verified only after those checks pass on that account.

See [LSA-to-Performance-Max compatibility](docs/LSA-MIGRATION.md) for the evidence, remaining uncertainty, and post-migration check.

## Get the release

Clone the repository and select the reviewed release:

```sh
git clone https://github.com/wvuhskr/lsa-responsiveness-tracker.git
cd lsa-responsiveness-tracker
git checkout v1.0.0
```

The CLI has no runtime dependencies, so no package installation is required when running it from the repository. Node.js 20 or newer is required.

## Try it before connecting an account

The deterministic synthetic demo uses no account configuration, credentials, or private data. Run these commands from the package root with Node.js 20 or newer:

```sh
mkdir -p ./private-output
chmod 700 ./private-output
node ./bin/lsa-responsiveness.js demo --output-dir ./private-output/demo
```

Open `./private-output/demo/report.html` to inspect the complete report experience.

The demo is intentionally synthetic. Its percentages prove the local workflow runs; they are not benchmarks for real advertisers.

## Use it with a real LSA account

You can use the portable Agent Skill to coordinate a compatible connector, or save the connector output yourself and run the CLI directly.

### Option 1: Let an Agent Skill guide the workflow

The bundled skill discovers a connector by capability rather than provider name. It inspects the live tool schema, identifies accessible accounts, probes the required fields, drains pagination, saves private inputs, and invokes the frozen CLI.

Install it into a project:

```sh
node ./scripts/install-skill.mjs install --platform codex --scope project --project /path/to/project
node ./scripts/install-skill.mjs install --platform claude --scope project --project /path/to/project
```

Then ask the agent:

> Use the LSA Responsiveness Tracker skill to create a private 90-day report for my selected LSA accounts. Keep raw rows and customer data out of chat.

Project installs support `agents`, `codex`, `cursor`, `opencode`, `gemini`, and `claude`. User installs are available for Codex, Claude, and OpenCode:

```sh
node ./scripts/install-skill.mjs install --platform codex --scope user
```

Add `--dry-run` to preview an install without writing. Uninstall with the same platform, scope, and project arguments:

```sh
node ./scripts/install-skill.mjs uninstall --platform codex --scope project --project /path/to/project
```

Project destinations are `.agents/skills/lsa-responsiveness-tracker` for Agents, Codex, Cursor, OpenCode, and Gemini, and `.claude/skills/lsa-responsiveness-tracker` for Claude. User destinations follow the supported platform's standard skill directory.

The installer copies only the three Agent Skill files and an installation receipt containing their hashes. It does not copy connector credentials or lead data. Keep this package at the receipt's `cliEntry` location while using the installed skill because the skill calls the packaged CLI.

Agent products differ in skill discovery, permissions, metadata, and invocation. A supported install path does not imply identical feature depth on every platform.

### Option 2: Run the CLI directly

Start with the safe synthetic examples:

- [`examples/config.example.json`](examples/config.example.json) defines reporting time, lookback window, account time zone, privacy options, and manifest location.
- [`examples/input-manifest.example.json`](examples/input-manifest.example.json) demonstrates a complete single-page input. Production manifests may instead prove a fully consumed page-token chain or an explicitly complete saved result.
- [`examples/synthetic-connector-response.json`](examples/synthetic-connector-response.json) shows one supported connector-response shape.

Copy the config and manifest into private, untracked storage before replacing any synthetic values. The manifest is the trust boundary between data collection and calculation: it identifies the saved page files, their envelope, and the evidence that collection finished.

Validate a saved response without printing row values, paths, IDs, or lead counts:

```sh
node ./bin/lsa-responsiveness.js probe --input ./private-input/page-1.json --format auto
```

Generate the report only after every account has a validated completion manifest:

```sh
node ./bin/lsa-responsiveness.js report --config ./private-input/config.json --output-dir ./private-output
```

The `report` command writes its bundle below `<output-dir>/report/`:

- `report.html`
- `summary.json`
- `report-manifest.json`
- `recent-unanswered.csv` only when explicitly enabled

History is disabled in the example. When enabled, its path is resolved from the output directory and its aggregate-only update is committed with the report as one transaction.

## Connector compatibility

This release works with any MCP or other tool that can:

- execute raw GAQL against `local_services_lead_conversation` for the selected customer;
- return the required row-level fields and returned-column metadata;
- expose or preserve enough pagination evidence to establish that every page was saved; and
- save the result in the supported `columns-data` or nested Google Ads `results` envelope.

The package is not bound to a provider or tool name. Aggregation-only connectors are unsupported because a precomputed percentage cannot prove the event-level numerator, denominator, reply timing, or completeness.

## Metric definition

The versioned metric combines eligible message leads and inbound phone leads:

```text
total responsiveness =
  (replied messages + connected calls)
  / (eligible messages + total inbound calls)
```

- A phone lead is treated as connected when a consumer call event lasts more than 1,000 milliseconds or the lead contains an advertiser event.
- A message is treated as replied when an advertiser event occurs at or after the first consumer event. A text reply or callback can count.
- A never-replied message counts against the rate only while it is within the configured recent-unanswered window, which defaults to seven days. Older never-replied messages are reported separately and excluded from the rate.
- Reply-speed buckets show responses within 5 minutes, within 1 hour, within 24 hours, and over 24 hours.

Message timing is precise when the complete required event history is available. Phone connected status is approximate because the Google Ads conversation data does not make every missed inbound call unambiguous.

## Privacy and safety

The Node.js CLI has no runtime dependencies, telemetry, or network calls. Connector access happens outside the CLI. Raw responses, configs, manifests, page tokens, and reports should stay outside the repository in private storage.

Recommended local permissions are directory mode `0700` and file mode `0600`. The public example disables both lead IDs and message text. The CLI fails closed on malformed, conflicting, or incomplete input and uses sanitized errors by default.

Enabling the optional recent-unanswered CSV may place opted-in lead identifiers or message text in a private output. Treat that file as customer data and do not publish it.

Report suspected vulnerabilities through the private process in [SECURITY.md](SECURITY.md). Never put real customer IDs, lead data, credentials, connector responses, reports, or private paths in a public issue.

## What it intentionally does not do

- It does not reproduce or claim to know Google's private LSA responsiveness formula.
- It does not replace a CRM, call-tracking platform, or lead-management process.
- It does not answer leads, change campaigns, or write to Google Ads.
- It does not accept an aggregation-only responsiveness score as source evidence.
- It does not claim guaranteed compatibility with a migrated account before a live post-migration probe passes.
- This release does not include scheduling automation or hosted reporting.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected internal failure |
| 2 | Usage, config, or path-policy failure |
| 3 | Required connector capability unsupported |
| 4 | Malformed, incomplete, conflicting, or connector-error data |
| 5 | Output or transaction safety failure |

## Known limitations

- A same-user or privileged process can still create a final-pathname race at the accepted last-system-call boundary.
- Saved-result completeness depends on truthful connector evidence and is not cryptographic proof.
- This release was verified locally on Node 24; Node 20 compatibility remains for later CI validation.
- Platform path compatibility does not prove equal Agent Skill feature depth across products.
- Scheduling, CI, screenshots, and reproducible release archives are not included in this release.

## Release history

See [CHANGELOG.md](CHANGELOG.md) for the sanitized public release history.

## License

MIT. Copyright (c) 2026 Alex Murtha. See [LICENSE](LICENSE).
