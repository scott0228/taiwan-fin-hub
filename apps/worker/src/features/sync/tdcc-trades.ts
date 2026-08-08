import {
  acquireSyncJobLock,
  markManualSyncFailure,
  releaseSyncJobLock,
  type SyncStatus,
  type SyncTrigger,
} from "@taiwan-fin-hub/db";
import type { Env } from "../../platform/env";
import {
  canonicalSyncLockRowId,
  isUserActionError,
  safeErrorMessage,
  startSyncLockHeartbeat,
  SYNC_LOCK_LEASE_MS,
  TDCC_SCOPE_TRADES,
} from "./service";
import { runConnectorSync } from "./registry";
import { safelySendSyncNotification } from "../notifications/service";

export const TDCC_TRADES_MAX_LOCK_ATTEMPTS = 5;

export type TdccTradesFollowUpResult = {
  requeue: boolean;
  attempt: number;
};

// Runs the TDCC trade-history scope in its own queue invocation so the
// backfill gets a fresh Workers subrequest budget (the free plan caps
// external subrequests per invocation). Requeues itself while the backfill
// is incomplete and the cursor keeps advancing.
export async function runTdccTradesFollowUp(
  env: Env,
  trigger: SyncTrigger,
  attempt: number,
): Promise<TdccTradesFollowUpResult> {
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId("tdcc");
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope: TDCC_SCOPE_TRADES,
    trigger,
    runId,
    leaseMs: SYNC_LOCK_LEASE_MS,
  });
  if (!locked) {
    if (attempt >= TDCC_TRADES_MAX_LOCK_ATTEMPTS) {
      console.error(
        JSON.stringify({
          event: "tdcc_trades_follow_up_abandoned",
          reason: "lock_busy",
          attempt,
        }),
      );
      return { requeue: false, attempt };
    }
    return { requeue: true, attempt: attempt + 1 };
  }

  const stopHeartbeat = startSyncLockHeartbeat(env.DB, lockRowId, runId);
  const startedAt = Date.now();
  try {
    const outcome = await runConnectorSync(
      env,
      "tdcc",
      trigger,
      TDCC_SCOPE_TRADES,
    );
    const requeue = Boolean(
      outcome.backfillIncomplete && outcome.cursorUpdated,
    );
    console.log(
      JSON.stringify({
        event: "tdcc_trades_follow_up_finished",
        trigger,
        records: outcome.records,
        backfillIncomplete: outcome.backfillIncomplete ?? false,
        requeue,
        durationMs: Date.now() - startedAt,
      }),
    );
    return { requeue, attempt: 1 };
  } catch (error) {
    const status: SyncStatus = isUserActionError(error)
      ? "needs_user_action"
      : "failed";
    // Surfaces the deferred-phase failure on the tdcc:all job row without
    // advancing next_run_at (the run that enqueued us already rescheduled it).
    await markManualSyncFailure(env.DB, "tdcc", "all", {
      status,
      errorMessage: safeErrorMessage(error),
    });
    await safelySendSyncNotification(env, { connectorId: "tdcc", status });
    console.error(
      JSON.stringify({
        event: "tdcc_trades_follow_up_failed",
        trigger,
        status,
        message: safeErrorMessage(error),
        durationMs: Date.now() - startedAt,
      }),
    );
    return { requeue: false, attempt };
  } finally {
    stopHeartbeat();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}
