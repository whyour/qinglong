// Authentication owns its bounded pre-body overload shield.
import { createHmac, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface ClusterControlAuthenticationShieldOptions {
  readonly windowMs: number;
  readonly maxRequestsPerPeer: number;
  readonly maxRequestsGlobal: number;
  readonly maxTrackedPeers: number;
  readonly now?: () => number;
}

export type ClusterControlAuthenticationShieldRejectionReason =
  | 'capacity'
  | 'clock'
  | 'global'
  | 'peer';

export type ClusterControlAuthenticationShieldResult =
  | {
      readonly allowed: true;
      /**
       * Returns this provisional attempt budget after the pre-body admission
       * preflight has succeeded. Idempotent and scoped to the exact windows
       * consumed by this result.
       */
      refund(): void;
    }
  | {
      readonly allowed: false;
      readonly reason: ClusterControlAuthenticationShieldRejectionReason;
      readonly retryAfterMs: number;
    };

export interface ClusterControlAuthenticationShield {
  consume(
    peerAddress: string | undefined,
  ): ClusterControlAuthenticationShieldResult;
  close(): void;
}

interface PeerWindow {
  readonly startedAt: number;
  readonly count: number;
}

const FINGERPRINT_KEY_BYTES = 32;
const MAX_PEER_ADDRESS_BYTES = 128;
const MAX_PRUNE_PER_ATTEMPT = 64;
const UNKNOWN_PEER = '<unknown-transport-peer>';

function normalizedPeerAddress(peerAddress: string | undefined): string {
  if (
    typeof peerAddress !== 'string' ||
    peerAddress.length === 0 ||
    Buffer.byteLength(peerAddress) > MAX_PEER_ADDRESS_BYTES ||
    /[\0\r\n]/.test(peerAddress)
  ) {
    return UNKNOWN_PEER;
  }
  return peerAddress;
}

function remainingWindow(
  now: number,
  startedAt: number,
  windowMs: number,
): number {
  return Math.max(1, Math.ceil(windowMs - (now - startedAt)));
}

/**
 * Creates a process-local overload shield for authentication attempts. It is
 * deliberately not an authorization or distributed quota authority: every
 * cluster-control replica owns a bounded, disposable window.
 */
export function createClusterControlAuthenticationShield(
  options: ClusterControlAuthenticationShieldOptions,
): ClusterControlAuthenticationShield {
  const now = options.now ?? (() => performance.now());
  const fingerprintKey = randomBytes(FINGERPRINT_KEY_BYTES);
  const peers = new Map<string, PeerWindow>();
  let globalWindow: PeerWindow | undefined;
  let lastNow = 0;
  let closed = false;

  const fingerprint = (peerAddress: string | undefined): string =>
    createHmac('sha256', fingerprintKey)
      .update('qinglong.cluster-control.authentication-peer\0')
      .update(normalizedPeerAddress(peerAddress))
      .digest('base64url');

  const pruneExpired = (currentTime: number): void => {
    let scanned = 0;
    for (const [key, window] of peers) {
      if (scanned >= MAX_PRUNE_PER_ATTEMPT) return;
      scanned += 1;
      if (currentTime - window.startedAt >= options.windowMs) {
        peers.delete(key);
      }
    }
  };

  const accepted = (
    peer: string,
    peerStartedAt: number,
    globalStartedAt: number,
  ): ClusterControlAuthenticationShieldResult => {
    let completed = false;
    return Object.freeze({
      allowed: true as const,
      refund() {
        if (completed || closed) return;
        completed = true;
        if (
          globalWindow?.startedAt === globalStartedAt &&
          globalWindow.count > 0
        ) {
          globalWindow = {
            startedAt: globalWindow.startedAt,
            count: globalWindow.count - 1,
          };
        }
        const currentPeerWindow = peers.get(peer);
        if (
          currentPeerWindow?.startedAt === peerStartedAt &&
          currentPeerWindow.count > 0
        ) {
          if (currentPeerWindow.count === 1) peers.delete(peer);
          else {
            peers.set(peer, {
              startedAt: currentPeerWindow.startedAt,
              count: currentPeerWindow.count - 1,
            });
          }
        }
      },
    });
  };

  return {
    consume(peerAddress) {
      if (closed) {
        return Object.freeze({
          allowed: false,
          reason: 'clock',
          retryAfterMs: options.windowMs,
        });
      }

      let currentTime: number;
      try {
        currentTime = now();
      } catch {
        return Object.freeze({
          allowed: false,
          reason: 'clock',
          retryAfterMs: options.windowMs,
        });
      }
      if (
        !Number.isFinite(currentTime) ||
        currentTime < 0 ||
        currentTime < lastNow
      ) {
        return Object.freeze({
          allowed: false,
          reason: 'clock',
          retryAfterMs: options.windowMs,
        });
      }
      lastNow = currentTime;

      if (
        !globalWindow ||
        currentTime - globalWindow.startedAt >= options.windowMs
      ) {
        globalWindow = { startedAt: currentTime, count: 0 };
      }
      if (globalWindow.count >= options.maxRequestsGlobal) {
        return Object.freeze({
          allowed: false,
          reason: 'global',
          retryAfterMs: remainingWindow(
            currentTime,
            globalWindow.startedAt,
            options.windowMs,
          ),
        });
      }
      globalWindow = {
        startedAt: globalWindow.startedAt,
        count: globalWindow.count + 1,
      };

      const peer = fingerprint(peerAddress);
      let peerWindow = peers.get(peer);
      if (
        peerWindow &&
        currentTime - peerWindow.startedAt >= options.windowMs
      ) {
        peers.delete(peer);
        peerWindow = undefined;
      }
      if (peerWindow) {
        if (peerWindow.count >= options.maxRequestsPerPeer) {
          return Object.freeze({
            allowed: false,
            reason: 'peer',
            retryAfterMs: remainingWindow(
              currentTime,
              peerWindow.startedAt,
              options.windowMs,
            ),
          });
        }
        peers.delete(peer);
        peers.set(peer, {
          startedAt: peerWindow.startedAt,
          count: peerWindow.count + 1,
        });
        return accepted(peer, peerWindow.startedAt, globalWindow.startedAt);
      }

      if (peers.size >= options.maxTrackedPeers) pruneExpired(currentTime);
      if (peers.size >= options.maxTrackedPeers) {
        return Object.freeze({
          allowed: false,
          reason: 'capacity',
          retryAfterMs: options.windowMs,
        });
      }
      peers.set(peer, { startedAt: currentTime, count: 1 });
      return accepted(peer, currentTime, globalWindow.startedAt);
    },
    close() {
      if (closed) return;
      closed = true;
      peers.clear();
      globalWindow = undefined;
      fingerprintKey.fill(0);
    },
  };
}
