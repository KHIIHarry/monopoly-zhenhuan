export type RoomTrashCleanerOptions = {
  purgeExpiredRooms: () => Promise<Array<{ id: string; deleted: boolean }>>;
  intervalMs?: number;
  onError: (error: unknown) => void;
};

const defaultIntervalMs = 60_000;
const maximumIntervalMs = 2_147_483_647;

export function startRoomTrashCleaner(options: RoomTrashCleanerOptions) {
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const runNow = () => {
    if (stopped) return Promise.resolve();
    if (running) return inFlight ?? Promise.resolve();
    running = true;
    const task = Promise.resolve()
      .then(async () => { await options.purgeExpiredRooms(); })
      .catch((error) => {
        try {
          options.onError(error);
        } catch {
          // Error reporting is best-effort and must not break scheduling.
        }
      })
      .finally(() => {
        running = false;
        if (inFlight === task) inFlight = null;
      });
    inFlight = task;
    return task;
  };

  void runNow();
  const intervalMs = Number.isFinite(options.intervalMs)
    && options.intervalMs! > 0
    && options.intervalMs! <= maximumIntervalMs
    ? options.intervalMs!
    : defaultIntervalMs;
  const timer = setInterval(() => { void runNow(); }, intervalMs);

  return {
    runNow,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
