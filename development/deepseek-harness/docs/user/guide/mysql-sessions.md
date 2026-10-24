# Select MySQL for CLI and SDK sessions

English | [中文](mysql-sessions.zh.md)

## Summary

Select an administrator-provisioned MySQL Session store with an explicit profile patch. The ordinary CLI, TypeScript SDK and Python SDK keep their Native Agent, history and event APIs. The shipped defaults continue to use JSONL; existing files are not imported or rewritten.

## Table of Contents

- [Prepare the deployment](#prepare-the-deployment)
- [Choose the patch](#choose-the-patch)
- [Run the CLI or SDK](#run-the-cli-or-sdk)
- [Inspect data and failures](#inspect-data-and-failures)
- [Deployment limits](#deployment-limits)

<a id="prepare-the-deployment"></a>
## Prepare the deployment

Use an isolated Harness home and an approved MySQL endpoint. An administrator supplies a database-scoped account, the complete matching R7 schema, and an existing `dsh_stores.store_key` namespace. The [connection reference](../../../packages/storage/mysql/README.md) owns server settings, schema initialization and upgrades; the [Session provider reference](../../../packages/session/session-persistence-mysql/README.md) owns namespace and ownership rules. These examples select `schemaMode: verify` and perform no initialization or historical import.

Install matching-version artifacts of `@deepseek-ai/dsh-mysql` and `@deepseek-ai/dsh-session-persistence-mysql` as optional dependencies of the selected profile. `sdk-minimal` also needs the `@deepseek-ai/dsh-credentials-local` plugin. Use the existing [profile package management](../../../apps/cli/README.md#profiles) for reviewed artifacts. Package installation alone does not mount these plugins; the patch provides their rows. Their presence in a development checkout does not mean the CLI distribution or Python runtime wheel includes them.

Supply these settings in the launching environment. Set the password through the Host credential provider or its inherited environment reference; never put its value in a patch, URL or diagnostic attachment.

| Setting | Meaning |
|---|---|
| `DSH_MYSQL_HOST`, `DSH_MYSQL_PORT` | Reviewed database hostname and explicit TCP port |
| `DSH_MYSQL_DATABASE`, `DSH_MYSQL_USER` | Existing database and its scoped account |
| `DSH_MYSQL_STORE_KEY` | Existing administrator-provisioned namespace |
| `DSH_MYSQL_PASSWORD` | Credential reference consumed by `passwordRef`; its secret value stays outside the patch |
| `DSH_HOME` | Profile configuration and remaining local application data |

Model credentials and endpoints remain separate. Changing Session persistence does not restrict model, tool or plugin networking; the [private deployment guide](enterprise-private-deployment.md) describes those choices.

<a id="choose-the-patch"></a>
## Choose the patch

Save the appropriate repository example at a reviewed external path. The npm CLI's current file manifest does not include `config/examples/`; these links are repository reference assets.

| Profile | Example | Applied selection |
|---|---|---|
| `headless` or `sdk` | [base.cordis.yml](../../../apps/cli/config/examples/mysql-session/base.cordis.yml) | Disable `session-persistence-jsonl`; mount the MySQL connection and Session provider using the existing credentials service |
| `sdk-minimal` | [sdk-minimal.cordis.yml](../../../apps/cli/config/examples/mysql-session/sdk-minimal.cordis.yml) | Disable `sessions`; mount credentials, the MySQL connection and Session provider |

Pass the patch explicitly after other patches that select persistence. Cordis replaces a targeted row's entire `config`; an endpoint override must restate its required fields. Keep the same namespace when continuing a Session. Another namespace is a separate store, even with the same external Session id.

Both examples add `sessionPersistence` to the existing required `agent-loop` entry's dependencies. Loader retains the plugin's static dependencies. These examples target the shipped profiles, which have no additional `agent-loop.inject` metadata; a custom profile must preserve its own metadata dependencies when adding this requirement. Keep that requirement in later patches so unavailable persistence cannot become a memory-only run.

<a id="run-the-cli-or-sdk"></a>
## Run the CLI or SDK

With the base patch saved and the deployment environment prepared, use the ordinary launcher:

```sh
dsh --profile headless --patch /absolute/mysql/base.cordis.yml --json "First request"
dsh --profile headless --patch /absolute/mysql/base.cordis.yml --json --session-id <returned-session-id> "Continue"
```

The opening JSON item contains the Session id. A missing stored id fails rather than creating a replacement history. Headless JSON is a bounded run projection, not an export of every raw Native event.

The TypeScript SDK forwards ordered patches to its same-version `dsh` dependency. Use the full SDK profile with the base patch:

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

await using harness = new DeepSeekHarness({
  profile: 'sdk', patches: ['/absolute/mysql/base.cordis.yml'],
  dshHome: '/absolute/mysql/home', cwd: '/absolute/workspace',
  provider: 'deepseek-official', model: 'deepseek-v4-pro',
})
const result = await harness.run('Continue', { sessionId: 'my-session' })
console.log(result.finalResponse)
```

Close the first instance before constructing another to resume the same Session. `env` replaces the TypeScript child's environment when supplied, so include all required deployment settings explicitly in that object.

Python can select the ordinary built JavaScript CLI through its public `dsh_bin`. This example uses the standalone profile and its corresponding patch:

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    dsh_bin="/absolute/dsh/lib/bin.js",
    profile="sdk-minimal", patches=("/absolute/mysql/sdk-minimal.cordis.yml",),
    dsh_home="/absolute/mysql/home", cwd="/absolute/workspace",
    provider="deepseek-official", model="deepseek-v4-pro",
) as harness:
    result = harness.run("Continue", session_id="my-session")
print(result.final_response)
```

The JavaScript carrier needs supported Node.js on the child's `PATH`. Python `env` merges supplied values into its process environment. A second Harness with the same namespace and Session id resumes through the Native runtime after the first closes. Neither SDK exposes arbitrary application argv; composition remains profile selection plus patches.

<a id="inspect-data-and-failures"></a>
## Inspect data and failures

Session headers, complete event text, append receipts and writer leases live in the configured database namespace. The Harness home still contains profile configuration, credentials and other independently selected local resources. Existing JSONL files remain where they were; namespace selection does not migrate them or office/workspace data.

`verify` refuses an absent, incompatible or partially migrated schema without writing DDL or receipts. With the explicit dependency retained, an unavailable persistence service prevents the required AgentLoop from activating. Missing-credential acceptance exits nonzero before creating a MySQL pool or Native Session, with zero model requests. Correct the endpoint, credential, package installation or namespace before restarting. Preserve unknown transaction outcomes and consult durable receipts before retrying a write; persistence receipts do not authorize repeating external tool actions. Observe shutdown error logs: Cordis can resolve root disposal after recording a failed consumer drain.

<a id="deployment-limits"></a>
## Deployment limits

The repository's artifact acceptance covers explicit profile dependencies and the three public launch paths with a controlled HTTP/SSE model. Those successful recovery runs precede the required-dependency addition; the final patch has separate passing composition/schema and missing-credential startup checks, without repeating the successful recovery runs. This does not establish registry availability, `dsh plugin` installation, an npm release, or a Python wheel/single-executable deployment. Validate supplied artifacts and the target installation separately.

The shared recorded-session harvester still reads JSONL files. SQL-backed acceptance does not enable that driver, historical import, database generation migration, or wire-level lost-COMMIT fault coverage. The [provider limitations](../../../packages/session/session-persistence-mysql/README.md#known-limitations-and-deferred-work) retain the remaining compatibility and durability constraints.
