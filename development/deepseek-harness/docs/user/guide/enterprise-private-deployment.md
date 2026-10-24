# Prepare a private office deployment

English | [中文](enterprise-private-deployment.zh.md)

## Summary

Prepare an isolated office data home, a company model route, connection policy and explicit network choices without changing the running preview. The repository utility checks public JSON, produces an ordinary `dsh web --patch` overlay, reports local data locations and optionally checks reviewed health URLs. It never starts the application, reads credential values or changes existing application data.

## Table of Contents

- [Prepare and inspect](#prepare-and-inspect)
- [Verify artifacts and endpoints](#verify-artifacts-and-endpoints)
- [Apply the deployment](#apply-the-deployment)
- [Network choices and data locations](#network-choices-and-data-locations)
- [Offline backup and recovery](#offline-backup-and-recovery)
- [Upgrade and rollback](#upgrade-and-rollback)
- [Customer configuration and limits](#customer-configuration-and-limits)

<a id="prepare-and-inspect"></a>

## Prepare and inspect

Use the repository's supported Node and pnpm versions. Run the following PowerShell commands from the repository root; the parent `.local-run` directory must already exist. Copy the [public example](../../../apps/cli/config/examples/enterprise-private-deployment.json) before editing it:

```powershell
Copy-Item apps/cli/config/examples/enterprise-private-deployment.json ../.local-run/private-office.json
pnpm --config.verifyDepsBeforeRun=false exec tsx scripts/enterprise-private-deployment.ts --config ../.local-run/private-office.json
```

The example uses loopback placeholder services. Supply your actual model base URL, API protocol, model id, context capacity and output capacity. The supported custom protocols are `openai-completions`, `openai-responses` and `anthropic-messages`. `apiKeyEnv` names an existing Host credential reference; omit it only for an intentionally unauthenticated model service. Secret values belong in the existing credential provider or launching environment, never in this JSON.

`home` resolves relative to the JSON file. It does not expand `~`, environment variables or shell expressions. The example therefore points at `../.local-run/private-office-data` after copying. An absent home is valid and remains absent during inspection. A file or unreadable home prevents artifact creation. The report states declared locations and choices; it does not inspect the configuration of a running Host.

The office section supplies a first-run company directory, one fixed local employee identity, meeting availability consent, exact canonical connector origins, credential aliases and a connector timeout. IDs must be unique, the selected employee must exist and the directory must include an administrator. Bootstrap members do not replace an existing office directory. Configure real connections through the administrator's existing connection page after deploying the policy.

<a id="verify-artifacts-and-endpoints"></a>

## Verify artifacts and endpoints

Write to a new directory, then compare the artifacts with the same JSON:

```powershell
pnpm --config.verifyDepsBeforeRun=false exec tsx scripts/enterprise-private-deployment.ts --config ../.local-run/private-office.json --write ../.local-run/private-office-v1
pnpm --config.verifyDepsBeforeRun=false exec tsx scripts/enterprise-private-deployment.ts --config ../.local-run/private-office.json --verify ../.local-run/private-office-v1
```

The utility writes `private-office.patch.yml` and `launch.json`. It refuses an existing destination and never overwrites a profile. A failed write leaves an incomplete directory for inspection; choose a new destination for recovery. Verification rejects missing or changed artifacts. Moving the output changes its absolute launch path, so regenerate it at its intended location.

Network checks require the explicit `--probe` option:

```powershell
pnpm --config.verifyDepsBeforeRun=false exec tsx scripts/enterprise-private-deployment.ts --config ../.local-run/private-office.json --verify ../.local-run/private-office-v1 --probe
```

Each listed URL must share an origin with the configured model, an approved connector, enabled search or enabled feedback collector. Use an operator-approved read-only health path: a probe sends one unauthenticated GET and does not follow redirects, send credentials, read response bodies or retry automatically. A check is not model inference, credential validation or a business-action check. HTTP 401/403 is reported as `authentication-required`; redirects, HTTP failures, unreachable services, timeouts and cancellation remain separate outcomes.

Exit code `0` means local validation succeeded and every requested probe returned HTTP success. Code `1` means invalid configuration, a data-home problem or an artifact/file failure. Code `2` means at least one explicit probe was degraded, required authentication or was cancelled. Configuration and artifacts remain intact after a failed probe. Restore the endpoint or network and repeat the same command; Ctrl+C cancels the active request and remaining checks. The default command makes no network request.

<a id="apply-the-deployment"></a>

## Apply the deployment

Review the generated patch and launch metadata. The metadata contains the absolute patch path, repository working directory and required `DSH_HOME`, with no credential values. Use an isolated new home: the patch replaces complete plugin configs, including the `llm-pi-ai` provider section, and does not merge an existing deployment's custom routes or migrate its data. Preserve a source deployment's configuration and data separately before planning such a migration.

The existing CLI can inspect the composed profile without mounting services:

```powershell
$privateLaunch = Get-Content ../.local-run/private-office-v1/launch.json -Encoding UTF8 -Raw | ConvertFrom-Json
$env:DSH_HOME = $privateLaunch.environment.DSH_HOME
pnpm --config.verifyDepsBeforeRun=false dsh web --patch $privateLaunch.args[3] --dump-config
```

The deployment administrator starts the application with the same command after replacing `--dump-config` with `--no-open`; that target-environment operation requires the supplied services and credentials. Choose the configured private route in the existing Models interface. Keep the deployment patch after other ordinary overlays so its choices apply. Settings edited below that overlay can be overridden by its complete configs; change the reviewed JSON and generate a new artifact directory for deployment policy changes.

`--dump-config` prints the composed configuration. Review it locally and do not attach a dump from another deployment to diagnostics without checking it for inline secrets. The utility's own report never reads environment values, credential documents, session contents or remote response bodies.

<a id="network-choices-and-data-locations"></a>

## Network choices and data locations

The privacy fields control separate, existing mechanisms:

| Choice | Applied behavior |
| --- | --- |
| `sessionTelemetry.mode: disabled` | Disables the `session-telemetry-otel` row, so its exporter is not mounted. |
| `sessionTelemetry.mode: feedback-only` | Mounts the existing feedback-only backend with the explicit collector URL. Explicit user feedback can export an authorized session-log prefix. |
| `productAnalytics: disabled` | Disables both the desktop product exporter and product analytics intake rows. |
| `productAnalytics: profile-default` | Leaves both rows to the selected profile; ordinary Web disables them, while Desktop has its own collection policy. |
| `webSearch.enabled: false` | Disables the built-in DeepSeek search provider. An enabled provider requires its own endpoint, model and credential reference. |
| `webFetch: false` | Disables the built-in HTTP fetch provider. If search and fetch are both disabled, their built-in tool is disabled too. |

These choices are not a process firewall. Other installed model/account routes, Shell, subprocesses, browsers, MCP services and plugins retain their original capabilities. An enabled model sends admitted conversation context to its configured service; enabled web fetch can contact requested HTTP(S) destinations. Connector origins constrain office connector requests only. Enforce a company-wide egress allowlist in your network or operating system and validate that infrastructure independently. Later patches and environment policy can also affect the resulting process.

With the emitted `DSH_HOME`, the report lists `profiles/web`, `sessions`, `storages`, `attachments/v1`, `office/drive/v1`, `office/chat/v1`, `.credentials.yaml` and `cache`. It reads only the home directory's filesystem status. These are the shipped local providers' intended paths; custom storage plugins and explicit path overrides require their own inspection. Workspace files, shared agent configuration, browser storage and Desktop carrier data can exist outside this home. No storage engine is replaced with MySQL or another remote database.

<a id="offline-backup-and-recovery"></a>

## Offline backup and recovery

Stop the central Office authority and every employee Host, drain writers and child processes, and prevent new traffic until backup finishes. `--quiescent` acknowledges this operator requirement; the tool does not stop processes or acquire an application maintenance lock. Matching source scans detect changes but cannot make live multi-file writes transactional.

Back up the entire actual `DSH_HOME`, including Office directory, identity and invitation ledger together, Drive/chat bytes, all Native Session generations, attachments, profiles, credentials and storage-provider files. Add external workspaces, individual configuration files, Desktop data and custom-provider roots with `--root id=path`; the tool does not discover them. Roots cannot overlap; symlinks, junctions and special files are rejected. From the repository, use the pinned portable Node:

```powershell
$releaseNode = '../.local-run/node-v24.22.0-win-x64/node.exe'
& $releaseNode --import tsx/esm scripts/enterprise-backup.ts diagnostics --home ../.local-run/enterprise-preview-home
& $releaseNode --import tsx/esm scripts/enterprise-backup.ts backup --home ../.local-run/enterprise-preview-home --provider local --quiescent --output ../.local-run/release-backup-v1 --root deployment=enterprise-workbench.patch.yml
& $releaseNode --import tsx/esm scripts/enterprise-backup.ts verify --backup ../.local-run/release-backup-v1
& $releaseNode --import tsx/esm scripts/enterprise-backup.ts restore --backup ../.local-run/release-backup-v1 --output ../.local-run/release-restore-v1
```

Every destination must be new. A failed operation retains its incomplete directory for inspection; correct the failure and choose another destination. A complete backup has `manifest.json` and a SHA-256 `COMPLETE` marker. Verification checks all selected bytes and rejects missing, extra, changed or future-format payloads. Hashes detect corruption, not malicious replacement of both data and hashes. Backups contain credentials and business data: use reviewed Windows ACLs and encrypted storage. POSIX mode bits are retained; Windows ACLs require separate application before reopening. Output contains only totals or safe failure codes. Diagnostics return counts, bytes and available capacity; use the existing Drive quota view and approved health probes for application limits and endpoint status. Do not attach raw logs to support requests.

Verification totals and `RESTORED.json` identify the manifest bytes validated during that operation. Replacing the manifest file later cannot change this identity; the copied payload must still match those validated entries.

Restore creates `home/` and one directory per additional root without changing the original deployment or selecting a provider. Repoint an isolated Host to these restored roots. Before cutover, check existing-member login, one-time invitation behavior, permitted and denied file reads, exact attachment bytes, old Session reading and a new append. Never run two central authorities on the same data. File verification alone does not establish application recovery.

For MySQL, drain all database consumers and obtain a provider-owned frozen logical export. Add `--provider mysql-frozen-export --mysql-export <verified-export-directory>` instead of `--provider local`. The tool checks export bytes only; the database owner must verify complete logical content, lifecycle and staging import. A live datadir copy, namespace separation or checksum does not establish a database snapshot. Without a production maintenance fence and staging importer, keep cutover blocked and retain the original provider. See the [MySQL guide](mysql-sessions.md).

<a id="upgrade-and-rollback"></a>

## Upgrade and rollback

Record actual build/runtime versions, public Client values, providers, data roots and backup digest. Retain the current installer and application files. Verify an offline backup, restore to a fresh directory and perform the application checks above. Compile changed dependency faces; Office Remote changes also require the API remotes **Client** bundle and Web artifacts. Write the artifact record only after real successful commands.

Install the replacement in an isolated trial location with restored data. Check launch, original menus/shortcuts, plugin management, history, login and file permissions. Production update qualification additionally needs the real configured policy service and update feed. The explicit Windows `--unsigned --local` installer omits signing and update services and is a local installation trial; see [Desktop packaging](../../../apps/desktop/README.md#unsigned-windows-test-installer).

Before rollback, stop the replacement and freeze/export all newer writes. Preserve exports and both data roots. Restore the verified earlier backup to another fresh directory, then explicitly select the previous application/provider. A provider change needs a verified import of newer data before preservation can be claimed; uninstalling a plugin does not migrate data. Never overwrite active data, replace Session generations or truncate logs. If the old reader refuses a newer format, retain that data with its compatible reader and report rollback blocked.

<a id="customer-configuration-and-limits"></a>

## Customer configuration and limits

The customer provides reachable model endpoints and real capacities, model/search/connector credentials, approved read-only health paths, connector adapters and integration definitions, TLS/reverse-proxy configuration for remote access, filesystem permissions, backup policy and any required network isolation. The example's `principalId` selects a trusted local workstation identity; it is not a central employee login, SSO or a secure shared-host deployment. Use the existing [office architecture](../../subsystems/enterprise-office.md) and [reverse-proxy guide](public-deployments.md) for those separate deployment responsibilities.

The controlled local checks cover real profile composition, Loader activation, disabled exporters, unchanged artifacts across offline recovery, authentication/HTTP errors, blocked redirects, timeouts and cancellation. Customer model inference, actual company APIs, target-network isolation, SSO, MySQL, backup/restore and a running customer's effective policy remain operator verification tasks.

## Dev Note

None.
