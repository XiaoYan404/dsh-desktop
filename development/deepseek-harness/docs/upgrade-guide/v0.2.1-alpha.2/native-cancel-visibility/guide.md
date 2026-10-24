---
kind: upgrade-guide
description: Host plugins must await the Session Controller's asynchronous cancellation result.
---

# Await Session cancellation in Host plugins

English | [中文](guide.zh.md)

## Change

`ctx.sessionController.cancel(request)` returns `Promise<SessionCancelValue>` so the Host can check current Session visibility before stopping an Agent. Hidden Sessions return `session/not-found`. An unattached Session remains unavailable without restoration. The TypeScript and Python Remote clients continue awaiting the existing cancellation response.

## Migration

1. Find direct Host calls to `ctx.sessionController.cancel(request)` and await the returned Promise before reading `accepted` or reporting success.
2. Handle rejection through the caller's existing error path. Keep pending input until cancellation is confirmed.
3. Compile the Host plugin and verify an authorized cancellation returns `{ accepted: true }`; an attributed office Session rejects cancellation by another employee or after sign-out.
