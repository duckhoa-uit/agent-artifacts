import type { AppEnv } from "./types";
import { now } from "./utils";

export type UsageEvent = "upload" | "download" | "share";

export interface UsageContext {
  principalId: string;
  synthetic: boolean;
  eventType: UsageEvent;
  bytes?: number;
  timestamp?: number;
}

export function trackUsage(ctx: ExecutionContext, env: AppEnv, usage: UsageContext): void {
  ctx.waitUntil(recordUsage(env, usage).catch((cause) => {
    console.warn(JSON.stringify({
      event: "usage.rollup_failed",
      principal_id: usage.principalId,
      usage_event: usage.eventType,
      reason: cause instanceof Error ? cause.message : String(cause),
    }));
  }));
}

export async function recordUsage(env: AppEnv, usage: UsageContext): Promise<void> {
  const timestamp = usage.timestamp ?? now();
  const day = new Date(timestamp * 1000).toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO usage_daily (day, principal_id, event_type, synthetic, request_count, bytes_count, last_updated_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
     ON CONFLICT(day, principal_id, event_type, synthetic) DO UPDATE SET
       request_count = request_count + 1,
       bytes_count = bytes_count + excluded.bytes_count,
       last_updated_at = excluded.last_updated_at`,
  ).bind(day, usage.principalId, usage.eventType, usage.synthetic ? 1 : 0, usage.bytes ?? 0, timestamp).run();
}
