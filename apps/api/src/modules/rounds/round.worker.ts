import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { RoundsService } from "./rounds.service";

/**
 * Checks every REMINDER_POLL_SECONDS whether a doctor's round time has come, and tells the doctors (docs/ward-rounds.md). Off in tests (they call RoundsService.runDue directly) and when
 * REMINDER_WORKER_ENABLED=false. Safe on several instances: a round is one row per doctor, time and day, so a second instance finds it already made.
 */
@Injectable()
export class RoundWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(private readonly rounds: RoundsService, @Inject(CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    if (this.config.NODE_ENV === "test" || !this.config.REMINDER_WORKER_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.config.REMINDER_POLL_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const c = await this.rounds.runDue();
      if (c.created + c.missed > 0) logJson("info", "rounds_processed", c);
    } catch (e) {
      logJson("error", "round_worker_failed", { errorName: e instanceof Error ? e.name : typeof e, errorMessage: e instanceof Error ? e.message.slice(0, 300) : undefined });
    } finally {
      this.busy = false;
    }
  }
}
