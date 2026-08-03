import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  acquireSyncJobLock: vi.fn(),
  releaseSyncJobLock: vi.fn(),
  markManualSyncFailure: vi.fn(),
  runConnectorSync: vi.fn(),
  safelySendSyncNotification: vi.fn(),
  startSyncLockHeartbeat: vi.fn(),
  isUserActionError: vi.fn(),
}));

vi.mock("@taiwan-fin-hub/db", () => ({
  acquireSyncJobLock: mocks.acquireSyncJobLock,
  releaseSyncJobLock: mocks.releaseSyncJobLock,
  markManualSyncFailure: mocks.markManualSyncFailure,
}));

vi.mock("../../../src/features/sync/service", () => ({
  canonicalSyncLockRowId: (connectorId: string) => `${connectorId}:all`,
  isUserActionError: mocks.isUserActionError,
  safeErrorMessage: (error: unknown) => String(error),
  startSyncLockHeartbeat: mocks.startSyncLockHeartbeat,
  SYNC_LOCK_LEASE_MS: 30 * 60 * 1000,
  TDCC_SCOPE_TRADES: "trades",
}));

vi.mock("../../../src/features/sync/registry", () => ({
  runConnectorSync: mocks.runConnectorSync,
}));

vi.mock("../../../src/features/notifications/service", () => ({
  safelySendSyncNotification: mocks.safelySendSyncNotification,
}));

import {
  runTdccTradesFollowUp,
  TDCC_TRADES_MAX_LOCK_ATTEMPTS,
} from "../../../src/features/sync/tdcc-trades";

function env() {
  return { DB: {} as D1Database } as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquireSyncJobLock.mockResolvedValue(true);
  mocks.releaseSyncJobLock.mockResolvedValue(undefined);
  mocks.startSyncLockHeartbeat.mockReturnValue(vi.fn());
  mocks.isUserActionError.mockReturnValue(false);
  mocks.runConnectorSync.mockResolvedValue({
    success: true,
    connectorId: "tdcc",
    scope: "trades",
    records: 3,
    cursorUpdated: true,
  });
});

describe("runTdccTradesFollowUp", () => {
  it("runs the trades scope in its own invocation", async () => {
    const result = await runTdccTradesFollowUp(env(), "scheduled", 1);

    expect(mocks.runConnectorSync).toHaveBeenCalledWith(
      expect.anything(),
      "tdcc",
      "scheduled",
      "trades",
    );
    expect(result).toEqual({ requeue: false, attempt: 1 });
  });

  it("requeues while the backfill is incomplete and progressing", async () => {
    mocks.runConnectorSync.mockResolvedValue({
      success: true,
      connectorId: "tdcc",
      scope: "trades",
      records: 10,
      cursorUpdated: true,
      backfillIncomplete: true,
    });

    const result = await runTdccTradesFollowUp(env(), "scheduled", 3);

    expect(result).toEqual({ requeue: true, attempt: 1 });
  });

  it("stops when the backfill is incomplete but the cursor stalled", async () => {
    mocks.runConnectorSync.mockResolvedValue({
      success: true,
      connectorId: "tdcc",
      scope: "trades",
      records: 0,
      cursorUpdated: false,
      backfillIncomplete: true,
    });

    const result = await runTdccTradesFollowUp(env(), "scheduled", 1);

    expect(result).toEqual({ requeue: false, attempt: 1 });
  });

  it("retries later when the connector lock is busy", async () => {
    mocks.acquireSyncJobLock.mockResolvedValue(false);

    const result = await runTdccTradesFollowUp(env(), "manual", 1);

    expect(mocks.runConnectorSync).not.toHaveBeenCalled();
    expect(result).toEqual({ requeue: true, attempt: 2 });
  });

  it("gives up after exhausting lock retries", async () => {
    mocks.acquireSyncJobLock.mockResolvedValue(false);

    const result = await runTdccTradesFollowUp(
      env(),
      "manual",
      TDCC_TRADES_MAX_LOCK_ATTEMPTS,
    );

    expect(result).toEqual({
      requeue: false,
      attempt: TDCC_TRADES_MAX_LOCK_ATTEMPTS,
    });
  });

  it("records the failure on the sync job and notifies the user", async () => {
    mocks.runConnectorSync.mockRejectedValue(new Error("boom"));

    const result = await runTdccTradesFollowUp(env(), "scheduled", 1);

    expect(mocks.markManualSyncFailure).toHaveBeenCalledWith(
      expect.anything(),
      "tdcc",
      "all",
      { status: "failed", errorMessage: "Error: boom" },
    );
    expect(mocks.safelySendSyncNotification).toHaveBeenCalledWith(
      expect.anything(),
      { connectorId: "tdcc", status: "failed" },
    );
    expect(result).toEqual({ requeue: false, attempt: 1 });
    expect(mocks.releaseSyncJobLock).toHaveBeenCalledOnce();
  });
});
