---
description: "Serve authenticated employee work, calendar, chat and drive requests from one central office owner."
kind: "package-reference"
---

# @deepseek-ai/dsh-enterprise-office-gateway

English | [中文](README.zh.md)

## Summary

Employees sign in to one central company service while their own Harness Hosts retain models, conversations, native tools and settings. This gateway accepts only office operations and own-account controls. It binds every business actor to a durable session and rechecks queued writes before execution. Administrators provision employee passwords; employees manage their own password and device sessions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Configure the [office service](../office/README.md) and a credential provider before this gateway. The [example composition](example/office.cordis.example.yml) loads only credentials, storage and office plugins. Build the repository, copy that configuration to your deployment directory and supply a first-run password of 15–1024 characters through the `OFFICE_BOOTSTRAP_PASSWORD` credential reference. Start it from the repository root with `node packages/enterprise/office-gateway/example/server.mjs --config <absolute-config-path>`. Relative data paths resolve from the process working directory. Bootstrap applies once; changing the startup secret never resets saved credentials. The initial administrator creates employees in Team and sets their sign-in passwords there.

| Setting | Default | Purpose |
| --- | --- | --- |
| `host` | `127.0.0.1` | Office-only bind address |
| `port` | `3082` | Listener port; zero selects an ephemeral port |
| `ephemeralPortAttempts` | `16` | Automatic Fetch-compatible port candidates; 1–64, explicit ports bind once |
| `administratorId` | required | Existing administrator for first initialization |
| `initialPasswordRef` | absent | Credential reference required before first initialization |
| `loginRequestsPerMinute` | `20` | Separate per-source minute budgets for login attempts and first-password invitation attempts |

Configure each employee's `ui-office` row with `gatewayUrl` and an empty `principalId`; keep its local `enterprise-office` row disabled. The local native credential provider retains the central token. The browser receives sanitized connection state. Remote gateway URLs require HTTPS; loopback HTTP is supported for local deployment. Put the central listener behind your TLS reverse proxy for remote use. The [UI package](../../client/ui-office/README.md) owns the employee overlay example.

With the Office service's explicit `memberInvites` limits enabled, administrators can issue a finite code for an existing active member who has no password, then copy it for private delivery. The gateway sends no invitation externally. `GET /health` includes only the optional safe `memberInvites: { protocol: 1, maxTtlMs }` capability; disabled and older gateways omit it. The employee Host discovers this fixed endpoint separately from normal connection and sign-in, so absent or unavailable capability does not prevent existing login.

`POST /v1/invitations/accept` is the fixed pre-login endpoint and accepts only `{ code, newPassword }`. It shares the original browser-Origin rejection, uncompressed JSON validation, 8 KiB body limit and global request budget. Its own per-source attempt counter uses `loginRequestsPerMinute` independently of login attempts. Success returns `{ ok: true, value: { memberId } }` without a bearer token, cookie or automatic login. Replays cannot reset an existing credential. Administrators use the existing authenticated, allowlisted RPC endpoint for `memberInvite`, `issueMemberInvite` and `revokeMemberInvite`; callers cannot select another actor. Codes appear only in the first issuance response, and exact issuance retries return metadata alone. Follow the [Office recovery constraints](../office/README.md#use-this-package) when backing up invitation and credential data.

## Understand the implementation

Automatic port allocation uses the shared HTTP listener helper from the native Web carrier. A Fetch-blocked candidate closes before the next bind; exhausting `ephemeralPortAttempts` rejects startup with every candidate closed. Explicit ports retain their configured value, and bind/close errors reject immediately. The gateway retains its independent listener, request handlers and authentication; sharing allocation does not expose native Host routes.

The listener exposes health, sign-in/out, current identity, own sessions/password and one versioned office request endpoint. The request validator explicitly lists supported office methods and their argument schemas. It provides no generic Cordis, native file, terminal, model, plugin or tool execution endpoint. Browser-origin requests are rejected; the authenticated employee Host makes server-to-server requests. Authorization ignores caller-selected actors and roles. Current member authority and session validity are checked again inside the shared office write queue.

Requests use bounded JSON bodies, finite header/request timeouts and per-source request budgets. Responses disable caching; failures expose stable denial codes without raw storage errors or secrets. The current listener permits 300 requests per minute per source address, caps its budget map at 4096 entries, bounds ordinary account bodies to 8 KiB and office uploads to 12 MiB. The legacy whole-request path retains its 8 MiB file limit; resumable chunks use separately advertised bounds. Unload closes the owned listener and waits for admitted handlers. Existing office identity sessions survive a server restart.

## Further Exploration

- [Office authorization and persistence](../office/README.md).
- [Employee workbench and login](../../client/ui-office/README.md).
- [Subsystem API](../../../docs/subsystems/enterprise-office.md).
- [Real HTTP acceptance tests](tests/http.spec.ts).
- [First-password invitation HTTP tests](tests/member-invitations.spec.ts).

## Model Experience

### Office authentication

#### What the model sees

This gateway registers no model tools and adds no `Session` context. Passwords, token receipts and credential references are not model inputs.

#### Token effect

Zero direct model tokens.

#### KV Cache effect

No changes to model request history or reusable prefixes.

## Known Limitations and Deferred Work

- The current identity provider uses managed employee passwords. SSO, directory synchronization and multifactor authentication remain pending.
- One central office process owns the configured domains. Sharing JSON files between writers does not provide transactions or high availability.
- TLS termination belongs to the deployment proxy. Source-address budgets use the actual socket peer; forwarded address headers are not trusted, so a proxy shares that budget unless deployed with a suitable limit.
- The employee UI polls every five seconds while visible. Push delivery and large-history pagination remain pending; the Host client bounds responses to 16 MiB.

### Dev Note

The source example runs from a built repository and joins asynchronously mounted descendant plugins before reporting its actual listening address. Its production installation must provide each plugin named by the configuration; the gateway does not install dependencies or alter employee profiles. A separate Node-process check covers credential-reference bootstrap and persisted password/session recovery after restart.
