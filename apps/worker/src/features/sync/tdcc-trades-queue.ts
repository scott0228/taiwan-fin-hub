import type { SyncTrigger } from "@taiwan-fin-hub/db";
import type { Env } from "../../platform/env";

export const TDCC_TRADES_FOLLOW_UP_DELAY_SECONDS = 20;

// Kept free of other sync imports so both service.ts and scheduler-queue.ts
// can enqueue the follow-up without an import cycle.
export async function enqueueTdccTradesSync(
  env: Env,
  trigger: SyncTrigger,
  attempt = 1,
) {
  await env.SYNC_QUEUE.send(
    { type: "run-tdcc-trades", trigger, attempt },
    { delaySeconds: TDCC_TRADES_FOLLOW_UP_DELAY_SECONDS },
  );
}
