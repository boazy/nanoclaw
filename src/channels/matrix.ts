/**
 * Matrix channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Supports two auth methods (resolved by the adapter from env):
 *   - Access token: MATRIX_ACCESS_TOKEN + MATRIX_USER_ID
 *   - Password:     MATRIX_USERNAME + MATRIX_PASSWORD (+ optional MATRIX_USER_ID)
 *
 * Optional env vars:
 *   MATRIX_BOT_USERNAME         — display name for the bot (default: "bot")
 *   MATRIX_INVITE_AUTOJOIN      — "true" to auto-accept room invites
 *   MATRIX_INVITE_AUTOJOIN_ALLOWLIST — comma-separated user IDs allowed to invite
 *   MATRIX_RECOVERY_KEY         — enable E2EE cross-signing
 *   MATRIX_DEVICE_ID            — stable device ID across restarts
 */
import 'fake-indexeddb/auto';
import { createMatrixAdapter } from '@beeper/chat-adapter-matrix';

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

const ENV_KEYS = [
  'MATRIX_BASE_URL',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_USERNAME',
  'MATRIX_PASSWORD',
  'MATRIX_USER_ID',
  'MATRIX_BOT_USERNAME',
  'MATRIX_DEVICE_ID',
  'MATRIX_RECOVERY_KEY',
  'MATRIX_INVITE_AUTOJOIN',
  'MATRIX_INVITE_AUTOJOIN_ALLOWLIST',
] as const;

type AccountDataContent = Record<string, unknown>;

interface MatrixClientForWarmup {
  getCrypto?: () => {
    bootstrapCrossSigning?: (opts: Record<string, unknown>) => Promise<void>;
    crossSignDevice?: (deviceId: string) => Promise<void>;
  } | null;
  getAccountData?: (eventType: string) => unknown;
  getAccountDataFromServer?: (eventType: string) => Promise<AccountDataContent | null>;
  getEventMapper?: () => (raw: { type: string; content: AccountDataContent }) => unknown;
  isInitialSyncComplete?: () => boolean;
  store?: {
    storeAccountDataEvents?: (events: unknown[]) => void;
  };
}

/**
 * Force-fetch one global `account_data` type from the homeserver even when
 * `isInitialSyncComplete()` is true. matrix-js-sdk's
 * `getAccountDataFromServer` normally short-circuits to the local store
 * after initial sync; we temporarily override that flag so the network
 * branch runs and we can pick up account_data missing from the saved-sync
 * snapshot.
 */
async function forceFetchAccountData(client: MatrixClientForWarmup, type: string): Promise<AccountDataContent | null> {
  if (!client.getAccountDataFromServer || !client.isInitialSyncComplete) return null;
  const orig = client.isInitialSyncComplete.bind(client);
  client.isInitialSyncComplete = () => false;
  try {
    return (await client.getAccountDataFromServer(type)) ?? null;
  } finally {
    client.isInitialSyncComplete = orig;
  }
}

/**
 * Hydrate the matrix-js-sdk store with the secret-storage and cross-signing
 * `account_data` events that the bot's saved-sync snapshot did not include.
 *
 * After restart, the SDK boots from saved /sync data which may not contain
 * `m.secret_storage.default_key`, `m.secret_storage.key.<id>`, or the three
 * `m.cross_signing.*` encrypted secrets. Without them in the store,
 * `secretStorage.get(...)` returns `undefined` (because
 * `getAccountDataFromServer` short-circuits), and
 * `crypto.bootstrapCrossSigning({})` falls into the upload-new-keys path
 * which needs UIA we don't have.
 *
 * We force-fetch each event from the homeserver, build a `MatrixEvent`
 * via `client.getEventMapper()`, and inject the events into the local
 * store using the same path the sync handler uses
 * (`store.storeAccountDataEvents`). After this, `secretStorage.get` finds
 * the encrypted secrets, decrypts them via the recovery-key-backed
 * `getSecretStorageKey` callback the adapter wires up, and bootstrap
 * imports the cross-signing keys instead of trying to upload new ones.
 */
async function warmupSecretStorageAccountData(client: MatrixClientForWarmup): Promise<void> {
  if (!client.getEventMapper || !client.store?.storeAccountDataEvents) return;

  const mapper = client.getEventMapper();
  const toStore: unknown[] = [];

  async function ensure(type: string): Promise<AccountDataContent | null> {
    if (client.getAccountData?.(type)) return null;
    const content = await forceFetchAccountData(client, type);
    if (!content) return null;
    toStore.push(mapper({ type, content }));
    return content;
  }

  const defaultKey = await ensure('m.secret_storage.default_key');
  const defaultKeyId = typeof defaultKey?.key === 'string' ? defaultKey.key : null;
  if (defaultKeyId) {
    await ensure(`m.secret_storage.key.${defaultKeyId}`);
  }

  const master = await ensure('m.cross_signing.master');
  const selfSigning = await ensure('m.cross_signing.self_signing');
  const userSigning = await ensure('m.cross_signing.user_signing');

  const keyIds = new Set<string>();
  for (const secret of [master, selfSigning, userSigning]) {
    const encrypted = secret?.encrypted;
    if (encrypted && typeof encrypted === 'object') {
      for (const keyId of Object.keys(encrypted)) keyIds.add(keyId);
    }
  }
  for (const keyId of keyIds) {
    await ensure(`m.secret_storage.key.${keyId}`);
  }

  if (toStore.length > 0) {
    client.store!.storeAccountDataEvents!(toStore);
    log.info('Matrix: warmed up account_data store', { injectedCount: toStore.length });
  }
}

/**
 * Load the bot's existing cross-signing private keys from secret storage
 * and sign the bot's own device with the user-signing key, so recipients
 * see encrypted messages as "verified" rather than "encrypted by a device
 * not verified by its owner".
 *
 * The @beeper/chat-adapter-matrix adapter loads the megolm backup key from
 * secret storage but never invokes any cross-signing API. We do it after
 * `liveSyncReady`. To work around saved-sync booting the SDK with
 * `isInitialSyncComplete()` already true (which prevents
 * `secretStorage.get` from network-fetching missing account_data), we
 * pre-warm the local store with the relevant events via
 * `warmupSecretStorageAccountData` before calling `bootstrapCrossSigning`.
 *
 * Best-effort: failure logs a warning but does not block startup.
 */
async function selfSignBotDevice(adapter: ReturnType<typeof createMatrixAdapter>): Promise<void> {
  const a = adapter as unknown as Record<string, unknown>;
  const client = a.client as MatrixClientForWarmup | undefined;
  const deviceID = typeof a.deviceID === 'string' ? a.deviceID : null;
  if (!client || !deviceID) return;

  const crypto = client.getCrypto?.();
  if (!crypto) return;

  try {
    await warmupSecretStorageAccountData(client);
  } catch (err) {
    log.warn('Matrix: account_data warmup failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    if (crypto.bootstrapCrossSigning) {
      await crypto.bootstrapCrossSigning({});
      log.info('Matrix: bootstrapCrossSigning succeeded');
    }
  } catch (err) {
    log.warn('Matrix: bootstrapCrossSigning failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  try {
    if (crypto.crossSignDevice) {
      await crypto.crossSignDevice(deviceID);
      log.info('Matrix: cross-signed own device', { deviceID });
    }
  } catch (err) {
    log.warn('Matrix: crossSignDevice failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Wrap the Matrix adapter so DM conversations are identified by user handle
 * across the whole system, not by ephemeral room IDs.
 *
 * Matrix DMs live in rooms (e.g. "!abc:server"), but NanoClaw identifies
 * channels by platform_id. Using a user handle as platform_id means both
 * the user and the messaging group reference the same stable identifier.
 *
 * Two directions to bridge:
 *   - Outbound: delivery passes "matrix:@user:server" → resolve to room via openDM
 *   - Inbound: adapter emits "matrix:!room:server" → rewrite to user handle
 *     so the router finds the existing messaging group instead of creating
 *     a new one.
 *
 * Both resolutions are cached for the process lifetime.
 */
function wrapWithDmResolution(adapter: ReturnType<typeof createMatrixAdapter>): typeof adapter {
  const origPostMessage = adapter.postMessage.bind(adapter);
  const origStartTyping = adapter.startTyping.bind(adapter);
  const origChannelIdFromThreadId = adapter.channelIdFromThreadId.bind(adapter);

  const roomToUserCache = new Map<string, string>();
  const userToThreadCache = new Map<string, string>();
  const primedRooms = new Set<string>();

  /**
   * Seed matrix-js-sdk's Room state and rust-crypto's RoomEncryptor with the
   * `m.room.encryption` (and self `m.room.member`) state events for `roomID`.
   *
   * After restart, the SDK boots from saved /sync data which is incremental and
   * may not include unchanged state events; combined with `lazyLoadMembers`
   * this leaves DM rooms with `room.hasEncryptionStateEvent() === false` and
   * `room.getMyMembership() === "leave"`. matrix-js-sdk then silently sends
   * outbound messages as plaintext m.room.message instead of m.room.encrypted.
   *
   * Fix: fetch full room state via GET /rooms/{id}/state, run the encryption
   * event through `crypto.onCryptoEvent` (which seeds rust-crypto's
   * RoomEncryptor), and inject both events into the Room's currentState.
   *
   * Cached per-room — at most one HTTP call per room per process lifetime.
   */
  async function primeRoomEncryptionIfNeeded(roomID: string): Promise<void> {
    if (primedRooms.has(roomID)) return;

    const a = adapter as unknown as Record<string, unknown>;
    const client = a.client as
      | {
          getRoom?: (id: string) => unknown;
          roomState?: (id: string) => Promise<Array<Record<string, unknown>>>;
          getEventMapper?: () => (raw: Record<string, unknown>) => unknown;
          getCrypto?: () => { onCryptoEvent?: (room: unknown, event: unknown) => Promise<void> } | null;
          getUserId?: () => string | null;
        }
      | undefined;
    if (!client) return;

    const room = client.getRoom?.(roomID) as
      | {
          hasEncryptionStateEvent?: () => boolean;
          currentState?: { setStateEvents?: (events: unknown[]) => void };
        }
      | undefined;
    if (!room) return;

    if (room.hasEncryptionStateEvent?.()) {
      primedRooms.add(roomID);
      return;
    }

    let stateEvents: Array<Record<string, unknown>>;
    try {
      stateEvents = (await client.roomState?.(roomID)) ?? [];
    } catch (err) {
      log.warn('Matrix: roomState fetch failed, leaving room un-primed', {
        roomID,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const encRaw = stateEvents.find((e) => e?.type === 'm.room.encryption' && (e?.state_key ?? '') === '');
    if (!encRaw) {
      primedRooms.add(roomID);
      log.info('Matrix: room is unencrypted on server, no priming needed', { roomID });
      return;
    }

    const mapper = client.getEventMapper?.();
    const encEvent = mapper ? mapper(encRaw) : encRaw;

    const crypto = client.getCrypto?.();
    if (crypto?.onCryptoEvent) {
      try {
        await crypto.onCryptoEvent(room, encEvent);
      } catch (err) {
        log.warn('Matrix: crypto.onCryptoEvent failed', {
          roomID,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    room.currentState?.setStateEvents?.([encEvent]);

    const myUserId = client.getUserId?.();
    const myMemberRaw = myUserId
      ? stateEvents.find((e) => e?.type === 'm.room.member' && e?.state_key === myUserId)
      : null;
    if (myMemberRaw) {
      const myMemberEvent = mapper ? mapper(myMemberRaw) : myMemberRaw;
      room.currentState?.setStateEvents?.([myMemberEvent]);
    }

    log.info('Matrix: primed room encryption + membership state', {
      roomID,
      encryptionPrimed: Boolean(room.hasEncryptionStateEvent?.()),
      memberPrimed: Boolean(myMemberRaw),
    });
    primedRooms.add(roomID);
  }

  function isUserHandle(threadId: string): boolean {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      return !roomID.startsWith('!');
    } catch {
      return true;
    }
  }

  async function resolveThreadId(threadId: string): Promise<string> {
    if (!isUserHandle(threadId)) return threadId;

    const userHandle = threadId.startsWith('matrix:') ? threadId.slice('matrix:'.length) : threadId;

    const cached = userToThreadCache.get(userHandle);
    if (cached) return cached;

    // Check the adapter's persisted DM room mapping before calling openDM
    // (openDM hangs on Continuwuity)
    const stateAdapter = (adapter as any).stateAdapter;
    if (stateAdapter) {
      const dmKey = (adapter as any).getDMStorageKey?.(userHandle);
      if (dmKey) {
        const roomId = await stateAdapter.get(dmKey);
        if (roomId) {
          const resolved = adapter.encodeThreadId({ roomID: roomId });
          roomToUserCache.set(roomId, userHandle);
          userToThreadCache.set(userHandle, resolved);
          log.info('Matrix: resolved DM room from persisted state', { userHandle });
          return resolved;
        }
      }
    }

    log.info('Matrix: resolving DM room for user handle via openDM', { userHandle });
    const resolved = await adapter.openDM(userHandle);

    try {
      const { roomID } = adapter.decodeThreadId(resolved);
      roomToUserCache.set(roomID, userHandle);
      userToThreadCache.set(userHandle, resolved);
    } catch {
      // decode failure is non-fatal
    }

    return resolved;
  }

  // Rewrite inbound room-based channel IDs to user-handle form for DM rooms.
  // Non-DM rooms pass through unchanged.
  adapter.channelIdFromThreadId = (threadId: string): string => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      if (!roomID.startsWith('!')) return origChannelIdFromThreadId(threadId);

      const cached = roomToUserCache.get(roomID);
      if (cached) {
        userToThreadCache.set(cached, threadId);
        return `matrix:${cached}`;
      }

      // Not cached — check if this is a DM by membership count
      const client = (adapter as any).client;
      const room = client?.getRoom(roomID);
      if (!room) return origChannelIdFromThreadId(threadId);
      if (room.getJoinedMemberCount() > 2) return origChannelIdFromThreadId(threadId);

      const botId = (adapter as any).userID;
      const otherMember = room.getJoinedMembers().find((m: { userId: string }) => m.userId !== botId);
      if (!otherMember) return origChannelIdFromThreadId(threadId);

      roomToUserCache.set(roomID, otherMember.userId);
      userToThreadCache.set(otherMember.userId, threadId);
      return `matrix:${otherMember.userId}`;
    } catch {
      return origChannelIdFromThreadId(threadId);
    }
  };

  // The Chat SDK calls adapter.isDM(threadId) synchronously to decide whether
  // to dispatch to onDirectMessage handlers. The Matrix adapter doesn't expose
  // this method — it only has an async isDirectRoom(). We add a synchronous
  // isDM that checks room membership count: 2 members = DM.
  (adapter as any).isDM = (threadId: string): boolean => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      const client = (adapter as any).client;
      if (!client) return false;
      const room = client.getRoom(roomID);
      if (!room) return false;
      const members = room.getJoinedMemberCount();
      return members <= 2;
    } catch {
      return false;
    }
  };

  adapter.postMessage = async (
    threadId: string,
    ...args: Parameters<typeof origPostMessage> extends [string, ...infer R] ? R : never
  ) => {
    const resolvedTid = await resolveThreadId(threadId);

    let roomID: string | null = null;
    try {
      ({ roomID } = adapter.decodeThreadId(resolvedTid));
    } catch {
      roomID = null;
    }
    if (roomID) {
      await primeRoomEncryptionIfNeeded(roomID);
    }

    const a = adapter as unknown as Record<string, unknown>;
    const e2eeEnabled = Boolean(a.e2eeEnabled);
    if (e2eeEnabled && roomID) {
      const client = a.client as { getRoom?: (id: string) => unknown } | undefined;
      const room = client?.getRoom?.(roomID) as
        | {
            getJoinedMemberCount?: () => number;
            hasEncryptionStateEvent?: () => boolean;
          }
        | undefined;
      const memberCount = room?.getJoinedMemberCount?.() ?? 0;
      const hasEncState = Boolean(room?.hasEncryptionStateEvent?.());
      // DMs (<=2 members) on an E2EE adapter must always be encrypted.
      // Refuse to leak plaintext if priming couldn't establish encryption.
      if (memberCount > 0 && memberCount <= 2 && !hasEncState) {
        throw new Error(
          `Matrix: refusing to send plaintext to DM ${roomID} — encryption state could not be established`,
        );
      }
    }

    return origPostMessage(resolvedTid, ...args);
  };

  adapter.startTyping = async (threadId: string) => {
    const resolvedTid = await resolveThreadId(threadId);
    return origStartTyping(resolvedTid);
  };

  return adapter;
}

registerChannelAdapter('matrix', {
  factory: () => {
    const env = readEnvFile([...ENV_KEYS]);
    if (!env.MATRIX_BASE_URL) return null;
    if (!env.MATRIX_ACCESS_TOKEN && !(env.MATRIX_USERNAME && env.MATRIX_PASSWORD)) return null;

    for (const key of ENV_KEYS) {
      if (env[key]) process.env[key] = env[key];
    }

    // Default: auto-join room invites so DMs work without manual acceptance
    if (!process.env.MATRIX_INVITE_AUTOJOIN) {
      process.env.MATRIX_INVITE_AUTOJOIN = 'true';
    }

    const baseAdapter = createMatrixAdapter();

    log.info('Matrix adapter created', {
      e2eeEnabled: (baseAdapter as any).e2eeEnabled,
      hasRecoveryKey: Boolean((baseAdapter as any).recoveryKey),
      hasDeviceId: Boolean((baseAdapter as any).deviceID),
    });

    const matrixAdapter = wrapWithDmResolution(baseAdapter);
    const bridge = createChatSdkBridge({ adapter: matrixAdapter, concurrency: 'concurrent', supportsThreads: false });

    // Matrix user IDs contain ":" (e.g. "@user:matrix.org") which the shared
    // permissions module interprets as already-prefixed. Wrap onInbound to
    // ensure senderId always carries the "matrix:" channel prefix so user
    // records match between init-first-agent and inbound routing.
    const origSetup = bridge.setup.bind(bridge);
    bridge.setup = async (hostConfig) => {
      const origOnInbound = hostConfig.onInbound.bind(hostConfig);
      await origSetup({
        ...hostConfig,
        onInbound: (platformId, threadId, message) => {
          if (message.content && typeof message.content === 'object') {
            const content = message.content as Record<string, unknown>;
            if (typeof content.senderId === 'string' && !content.senderId.startsWith('matrix:')) {
              content.senderId = `matrix:${content.senderId}`;
            }
          }
          return origOnInbound(platformId, threadId, message);
        },
      });

      // Wait for Matrix sync to reach PREPARED state before returning from setup.
      // Without this, the host's delivery poll and sweep timer start immediately
      // and can starve the SDK's sync generator microtask queue, blocking
      // incremental syncs so new inbound messages never get dispatched.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if ((matrixAdapter as unknown as { liveSyncReady?: boolean }).liveSyncReady) {
            log.info('Matrix sync ready');
            clearInterval(check);
            resolve();
          }
        }, 500);
        setTimeout(() => {
          clearInterval(check);
          resolve();
        }, 30_000);
      });

      await selfSignBotDevice(matrixAdapter);
    };

    return bridge;
  },
});
