# apps/web browser e2e

English | [中文](README.zh.md)

These tests boot the real web composition in-process and drive it with real browsers over real HTTP. Chromium runs the full lane; the [model and reasoning picker scenario](declared-reasoning.e2e.ts) also runs in WebKit to cover native mouse focus behavior. [Session replay recovery](session-replay-reload.e2e.ts) runs native and office modes in both browsers, selecting the platform's `fresh-round-trip` recording. It covers active-stream reload, completed-turn reload, and reopening a Session, with actual command results and persisted events. Office interface expectations live in [their own directory](expected/office-session-replay-reload/); the native mode retains its shared expected output. The lane's mechanics — modes, fixtures, goldens, and the deliberate composition divergences from `dsh web` — are documented in [`scaffold.ts`](scaffold.ts) and the [browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

The [Drive scenarios](enterprise-office-drive.e2e.ts) also exercise reviewed replacement, history, historical ranges and deletion/restoration through actual HTTP Remotes while the browser retains its directory view. The [Drive reader comparison](fixtures/office-drive-reader-compat.mjs) opens legacy and replacement documents with frozen and current readers, checks read-only byte preservation and exercises authenticated office request admission. The [cleanup reader comparison](fixtures/office-drive-purge-reader-compat.mjs) verifies that unsupported cleanup records are rejected without rewriting data.

The version and recovery interface cases keep their own [expectations](expected/office-drive-lifecycle/). They cover source-file review and cancellation, concurrent metadata changes, failed publication and restoration, historical byte downloads, parent-permission withdrawal and recovery, reload and a small window. Concurrent changes use authoritative service writes; the interface must retain the reviewed draft until an explicit refresh or adoption.

The permanent-cleanup interface cases review owner scope, cancel without writes, retain an exact confirmation after a failed approval, and continue an existing pending receipt after a real object-unlink failure. Quota remains charged until completion. A Native `write`/`present` sequence creates an actual delivery; removing its Drive copy must preserve the original bytes and Session events, including the delivery's download after reload. A separate case withdraws inaccessible metadata and resets confirmation after the reviewed root changes. Only the new cleanup review expectation belongs to these cases; Native recordings remain unchanged.

Legacy catalog recovery scenarios in [office file tests](enterprise-office-files.e2e.ts) retain their own [expectations](expected/office-legacy-child/). They switch the real employee Host principal to check read restrictions without activating cold Agents, preserve original parent bytes and child prefixes, and distinguish the child's creation role from later parent reviews. The Native case creates the catalog before the parent's first office input and verifies actual Native file writing after resume. Historical fixtures include complete Native turns and the protected system head required by the current codec.

The synchronization protocol case in [connection tests](enterprise-office-connectors.e2e.ts) exercises real Remote codecs and customer HTTP reads while the integration page stays usable. Its [own expectation](expected/office-connector-sync/) covers actual outcome statuses, metadata-only history, retained original fields and customer request counts. Query authentication failures do not reuse a previous successful result.

Synchronization UI cases review and cancel without customer reads, recover failed durable publication and a lost post-commit acknowledgement using the original request, and display actual 401 failure without stale data. Reload restores saved history without another customer read. Connection changes hide existing fields; switching employees clears private views and opens an empty own history. A separate UI expectation shares the protocol case's owned directory, leaving Native recordings unchanged.

The [integration plugin lifecycle cases](enterprise-office-plugin-lifecycle.e2e.ts) navigate from company packages into the original manager. An actual Loader bundle registers and disposes a customer HTTP reader. Controlled pnpm copies the fixture into an isolated profile; real profile changes and loading cover review cancellation, enable/disable, uninstall confirmation and reinstalling a newer third-party version. No real customer platform or external registry installation is claimed. Their [own expectations](expected/office-plugin-lifecycle/) leave Native recordings unchanged.

The [submitted spreadsheet case](enterprise-office-xlsx.e2e.ts) uploads actual OOXML through Drive, associates its saved version with the existing Native input and reviews the exact file, version, digest and cell budget before allowing `office_read_xlsx`. It compares the persisted tool result with the next model request, checks original numeric lexemes and formula-cache states, and displays the actual result in the tool card. Only model inference is controlled; upload, parsing, Native persistence and browser delivery are real.

After installing workspace dependencies, install the browsers and their system dependencies from the repository root:

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium webkit
```

On Linux, `--with-deps` installs dependencies through the system package manager. The persistent CI VM must provide these dependencies through image maintenance; CI installs only the browser binaries, as required by the [failover runbook](../../../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.md).

After a complete build, launch selected browser tests through `pnpm run test:web:built`. The [HMR scenario](hmr-live.e2e.ts) requires pnpm's `npm_execpath` lifecycle entry to start its watchers without a shell. Browser helpers pin the recorded timezone to `Asia/Shanghai`; [isolation checks](support-timezone.e2e.ts) use explicit ambient contexts on Windows, where Chromium ignores `TZ`.

[Fixed rejection shortcuts](shortcuts-fixed.e2e.ts) select the platform's approval recording and verify that its actual target file was not written. [Worker deployment acceptance](preview-boot.e2e.ts) serves generated images from temporary files through URL-relative overrides, preserving URL separators on Windows and leaving build-owned `dist/` unchanged.

[Markdown image acceptance](markdown-images.e2e.ts) compares authored request paths, encoded URLs, response bytes and source-file bytes, preserving Windows separator spelling alongside image loading and failure-state assertions.

[Document copy acceptance](document-preview.e2e.ts) checks the code file's LF bytes, rendered text and exact input to the real clipboard write. Native code and spreadsheet clipboard readback uses CRLF on Windows and LF elsewhere, following the [platform text format](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats); the assertions compare actual readback without changing its line endings.

The replayed [Inspector case](session-inspector.e2e.ts) uses the platform's existing `fresh-round-trip` recording, compares its persisted Session read-only and checks the actual shell result's UTF-8 bytes. Windows Raw Log and Chat Group expectations live in [their own directory](expected/session-inspector-windows/); the other Inspector expectations remain shared with POSIX.

[Two-round Goal acceptance](goal-multi-turn-actions.e2e.ts) selects a [Windows recording](../../../snapshots/web/goal-multi-turn-actions-windows/) produced through `dsh web` and public Session export with a deterministic model substitute. It compares all eight real `pwsh` results byte-for-byte, including the explicit exit 127, and retains two six-step Native turns and Goal completion. The Windows Session is read-only during UI capture; POSIX recordings and UI expectations remain unchanged.

[Background task stop acceptance](background-job-list.e2e.ts) uses the platform's real shell and a bounded release-file barrier. The Windows case checks the exact per-run token in a file written by `pwsh` before capturing or stopping the job through the two-press control. It reuses its Native recording read-only and preserves the complete restored event prefix in public Session export. Its [Windows UI expectations](expected/background-job-list-windows/) retain the actual termination and user-cancellation details; the POSIX expectations remain unchanged.

Ordinary scenarios begin with no registered Workspace or Session and a durable marker recording a removed default Workspace, so explicit folder-selection scenarios retain control of their cwd. `launchWebScaffold({ firstUse: true })` leaves initialization eligible for startup scenarios.

The generated twelve-turn [continuous conversation case](chat-continuous-conversation.e2e.ts) submits every turn through the real composer, executes platform-native tools in turns four and nine and compares their exact output. It checks that streaming, persisted history and both tool disclosures remain attached to one Session; Windows uses the generic `pwsh` disclosure and CRLF output.

The long scroll-away [Chat contract cases](chat-scroll-contract.e2e.ts) keep the reader's anchor while chunks arrive and resume following at the bottom. The wheel case retains a tool's disclosure after virtual unmounting; the separate simulated-fling case changes scroll offsets without wheel input. Their Windows tools register a filesystem-event wait before publishing readiness, then emit the same 64 lines with exact CRLF after release; timeout and cleanup remain observable failures.

The terminal-card [navigation case](navigation-panes.e2e.ts) measures the actual command and loaded font before narrowing the card enough to require horizontal scrolling. Its historical Bash row supplies presentation metadata. The case preserves focus, keyboard, wheel, drag, clipboard, theme and restored-width checks against the existing expectations.

The authenticated-denial [audit case](enterprise-office-audit.e2e.ts) sends a real employee request through the central gateway, filters the administrator's saved denial metadata and checks actual downloaded NDJSON. The seven allowlisted fields include the safe denial code and exclude rejected input and credentials. The same employee's audit page and export RPCs remain denied.

The [office calendar case](enterprise-office.e2e.ts) advances the Host clock across company midnight, opens notifications and retries a temporary read failure. It checks that Today follows the company date while an explicitly selected day remains selected; browser and Host clocks stay independent.

## Completion observations

The [queue action scenarios](queue-actions.e2e.ts) wait separately for acknowledged row mutations and the session header's preset projection before comparing the collapsed queue. A queue response does not establish that session metadata has reached the browser. The original native and office expectations remain separate, and the scenarios verify durable FIFO behavior after the interface comparisons.

The [Steering cases](steering.e2e.ts) retain independent Host and browser clock pins and reset Playwright timer scheduling with `page.clock.runFor(0)` before sending. Their local turn-completion observations release listeners on failure. The queue-wide case uses the platform's Cmd/Ctrl shortcut and captures its flushed Windows Session under owned test artifacts. The single-row case retains strict comparison with its shared Session recording, which lacks the Windows ACL skill-catalog record; that platform fixture gap still fails the final comparison.

State-sensitive cases use Workspace, admission, attachment, and model-stream barriers to separate visible intermediate states from completed operations. Model-picker persistence assertions wait for the saved default, independently of menu closure. Details close waits for frame transitions; archive verification assigns an explicit title to the seeded Session and follows that identity across reload. The [CI test reliability workflow](../../../.agents/skills/dsh-ci-test-reliability/SKILL.md#synchronize-on-state) owns these synchronization rules.

[Idle-submission handoff](idle-submission-handoff.e2e.ts) waits up to the scaffold's 30-second turn-completion budget for Host frames and browser placement. Vitest owns scaffold teardown so a replay-consumption error does not replace the failed scenario assertion.

Plugin-manager switches wait up to `PLUGIN_TOGGLE_SETTLE_MS` (10 seconds) for the Host's profile write and the store's follow-up inventory read, the two steps that republish `aria-checked`; that constant's JSDoc records the measured chain.

Explicit scrolling uses `scrollIntoView` from `support.ts`: it resolves the locator again when its old element detaches and checks connection in the same browser task as native scrolling. Scenarios retain their visibility and geometry assertions after scrolling.

Office variants compare complete Conversations with separate expectations under `expected/office-*`; shared queue cards and reference menus retain their original expectations. Queue and subagent scenarios continue past those comparisons to verify exact occurrence edits, stop/retry behavior, and FIFO recovery against actual persisted events.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate, because they read Host services directly: `ctx.connection`, the Host `SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does not make a file part of the Client program — the two faces merge Cordis `Context` under the same keys with different services, so one program cannot see both. Moving these files into the Client aggregate makes every Host-service access fail to compile.

## Do not import `@deepseek-ai/dsh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript project, and every project it references, into the **Host build graph**. That has bitten this lane once already: four Client consumer packages reference `api/remotes`' Client face, which cannot compile until Host tsdown has generated `@deepseek-ai/dsh-goal/remote`, so the Host build phase ended up waiting on an artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here instead, next to the commented-out import that names the source module. A drift then surfaces as a missed selector or a stale mirrored value — a loud failure, never a silent pass. `scaffold.ts` follows this rule for the welcome-notice namespace, acknowledgement field, version, and asserted Chinese copy.

The built-client harness is the exception. `assembled-boot.ts` imports `AppWebEntry`, the boot-manifest type, and `RemoteMock`; `assembled-remote.ts` imports the Client test runtime's default responses and `RemoteMock`. These packages are explicit project references for booting the real shell against a test-owned carrier. The chat scenarios mirror `conversationContextKey` in `support.ts` instead of importing its Client owner.

Nothing mechanically enforces this rule; keep it in review.
