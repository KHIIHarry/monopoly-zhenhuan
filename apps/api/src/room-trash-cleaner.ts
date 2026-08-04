export type RoomTrashCleanerOptions = {
  purgeExpiredRooms: () => Promise<Array<{ id: string; deleted: boolean }>>;
  intervalMs?: number;
  onError: (error: unknown) => void;
};

export function startRoomTrashCleaner(options: RoomTrashCleanerOptions) {
  let running = false;
  let stopped = false;

  const runNow = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await options.purgeExpiredRooms();
    } catch (error) {
      options.onError(error);
    } finally {
      running = false;
    }
  };

  void runNow();
  const timer = setInterval(() => { void runNow(); }, options.intervalMs ?? 60_000);

  return {
    runNow,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
