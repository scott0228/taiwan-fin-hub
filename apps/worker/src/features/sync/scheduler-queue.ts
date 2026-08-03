import type { Env, ScheduledSyncQueueMessage } from "../../platform/env";
import { runSchedulerTick } from "./scheduler";
import { runTdccTradesFollowUp } from "./tdcc-trades";
import { enqueueTdccTradesSync } from "./tdcc-trades-queue";

const queueController = {
  cron: "queue:scheduled-sync",
} as ScheduledController;

export const SCHEDULED_SYNC_CHAIN_DELAY_SECONDS = 20;

export async function enqueueScheduledSync(env: Env, delaySeconds = 0) {
  const message = { type: "run-next-scheduled-sync" } as const;
  if (delaySeconds > 0) {
    await env.SYNC_QUEUE.send(message, { delaySeconds });
    return;
  }
  await env.SYNC_QUEUE.send(message);
}

export async function consumeScheduledSyncQueue(
  batch: MessageBatch<ScheduledSyncQueueMessage>,
  env: Env,
) {
  for (const message of batch.messages) {
    if (message.body.type === "run-tdcc-trades") {
      const result = await runTdccTradesFollowUp(
        env,
        message.body.trigger,
        message.body.attempt ?? 1,
      );
      if (result.requeue) {
        await enqueueTdccTradesSync(env, message.body.trigger, result.attempt);
      }
      message.ack();
      continue;
    }

    if (message.body.type !== "run-next-scheduled-sync") {
      console.error(
        JSON.stringify({
          event: "scheduled_sync_queue_message_rejected",
          messageId: message.id,
        }),
      );
      message.ack();
      continue;
    }

    const processed = await runSchedulerTick(env, queueController);
    if (processed) {
      await enqueueScheduledSync(env, SCHEDULED_SYNC_CHAIN_DELAY_SECONDS);
    }
    message.ack();
  }
}
