# boazy/nanoclaw Fork

Upstream: `qwibitai/nanoclaw`
Fork: `boazy/nanoclaw`

This file tracks all commits in the fork that diverge from upstream.
It is the authoritative reference for what we changed, why, and whether
each change is still needed. Update this file whenever commits are
added, rebased, amended, squashed, or dropped.

## Active Patches

### 1. Matrix channel adapter

**Commit:** `5f1c5f8` — Add Matrix channel adapter with E2EE support

**Files:**
- `src/channels/matrix.ts` (new)
- `src/channels/index.ts` (added import)
- `package.json` + `pnpm-lock.yaml` (added `@beeper/chat-adapter-matrix@0.2.0`)

**What:** Adds Matrix as a messaging channel via `@beeper/chat-adapter-matrix`.
The adapter is taken from NanoClaw's `channels` branch (`src/channels/matrix.ts`)
with a DM resolution wrapper that maps Matrix room IDs to stable user handles
for NanoClaw's platform_id system.

**Why upstream doesn't have it:** The `channels` branch has the raw adapter but
it's not merged to `main`. The upstream install flow uses the `/add-matrix` skill
to copy it in per-installation. We commit it directly so the fork is self-contained.

**Drop condition:** If upstream merges the `channels` branch Matrix adapter into
`main`, this commit can be dropped. Verify that the upstream version includes
the DM resolution wrapper and indexedDB disable — if not, keep our patches on top.

---

### 2. Disable indexedDB for Node.js crypto store

**Commit:** `5f1c5f8` (same as above, part of the adapter)

**Location:** `src/channels/matrix.ts`, factory function, after `createMatrixAdapter()`:
```typescript
(baseAdapter as any).e2eeConfig = {
  ...(baseAdapter as any).e2eeConfig,
  useIndexedDB: false,
};
```

**What:** `matrix-sdk-crypto-wasm` tries to use `indexedDB` for its crypto store,
but Node.js doesn't have `indexedDB`. The `@beeper/chat-adapter-matrix` should
fall back gracefully, but the default config evaluates `useIndexedDB !== false`
as `true` when the field is `undefined`. Explicitly setting it to `false` fixes this.

**Why:** Without this patch, the Matrix adapter crashes on startup with:
`The indexedDB getter returned null or undefined`

**Drop condition:** If `@beeper/chat-adapter-matrix` fixes its default to detect
missing `indexedDB` and default `useIndexedDB` to `false` in Node.js, this patch
can be dropped. Check the adapter's `maybeInitE2EE` method.

---

### 3. DM delivery cache (openDM loop fix)

**Commit:** `35d1de8` — Fix DM delivery: cache user→threadId from inbound to avoid openDM loop

**Location:** `src/channels/matrix.ts`, `wrapWithDmResolution` function.

**What:** Adds a `userToThreadCache` (Map<string, string>) alongside the existing
`roomToUserCache`. When an inbound message arrives and we resolve room→user, we
also cache user→threadId. Outbound delivery checks this cache before calling
`adapter.openDM()`, which hangs on Continuwuity (our homeserver).

**Why:** Without this cache, every outbound message to a user handle triggers
`adapter.openDM(userHandle)`, which calls the Matrix `/createRoom` endpoint.
On Continuwuity, this hangs indefinitely, causing the delivery poll to loop
every 4 seconds printing `Matrix: resolving DM room for user handle` forever.
The host process eventually becomes unresponsive to shutdown signals.

**Drop condition:** Two possible fixes upstream:
1. If `@beeper/chat-adapter-matrix` adds its own user→room cache or makes
   `openDM` idempotent/fast for existing rooms, this patch is unnecessary.
2. If Continuwuity fixes its `/createRoom` endpoint to return quickly for
   existing DMs, the timeout goes away — but the cache is still a performance
   improvement, so consider keeping it anyway.

---

## Reverted / Dropped Patches

### Recovery key pre-decode (reverted)

**Commits (all reverted, not in final tree):**
- `68bc2a6` — Fix recovery key format: decode base58 to raw Curve25519 bytes
- `c8cc2c3` — Fix recovery key: set decoded env var before adapter construction
- `129a97d` — Revert recovery key pre-decode: the verifyBackup error is server-side

**What happened:** We initially thought the `verifyBackup` error ("expected 32,
got 45 bytes") was caused by our recovery key format. After investigation, the
error was caused by the homeserver's backup `public_key` being double
base64-encoded (a Continuwuity/Nheko bug). We deleted and recreated the backup
from Element, which fixed the encoding. The adapter's internal `decodeRecoveryKey`
handles the recovery key format correctly — no pre-decoding needed.

**These commits exist in git history but their net effect is zero** — `129a97d`
reverts the changes from `68bc2a6` and `c8cc2c3`.

---

## Resync Procedure

See the `/sync-nanoclaw-fork` skill in the `openclaw` repo for the full
interactive resync workflow.

Quick reference:
```bash
cd ~/projects/personal/nanoclaw
git fetch upstream
git rebase upstream/main
# Resolve conflicts, checking each patch in this file
# After rebase: update commit hashes in this file
# Push: git push origin main --force-with-lease
```
