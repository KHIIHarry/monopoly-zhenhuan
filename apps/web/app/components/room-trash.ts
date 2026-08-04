export type AdminTrashRoom = {
  id: string;
  name: string;
  code: string;
  status: "LOBBY" | "ENDED" | "FINISHED" | "CLOSED";
  deletedAt: string;
  purgeAfter: string;
  deletedBy: { id: string; displayName: string } | null;
};

export type TrashOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error?: unknown };

export function createTrashRoomLoader({
  read,
  onValue,
  onError,
}: {
  read: () => Promise<AdminTrashRoom[]>;
  onValue: (rooms: AdminTrashRoom[]) => void;
  onError?: (error: unknown) => void | Promise<void>;
}) {
  let lifecycle = 0;
  let requestGeneration = 0;
  let inFlight: {
    lifecycle: number;
    promise: Promise<TrashOperationResult<AdminTrashRoom[]>>;
  } | null = null;

  function load() {
    const requestLifecycle = lifecycle;
    if (inFlight?.lifecycle === requestLifecycle) return inFlight.promise;

    const generation = ++requestGeneration;
    let request: Promise<AdminTrashRoom[]>;
    try {
      request = read();
    } catch (error) {
      request = Promise.reject(error);
    }
    const promise: Promise<TrashOperationResult<AdminTrashRoom[]>> = request
      .then((rooms): TrashOperationResult<AdminTrashRoom[]> => {
        if (
          requestLifecycle === lifecycle &&
          generation === requestGeneration
        )
          onValue(rooms);
        return { ok: true, value: rooms };
      })
      .catch(async (error): Promise<TrashOperationResult<AdminTrashRoom[]>> => {
        if (
          requestLifecycle === lifecycle &&
          generation === requestGeneration
        )
          await onError?.(error);
        return { ok: false, error };
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { lifecycle: requestLifecycle, promise };
    return promise;
  }

  return {
    load,
    invalidate() {
      lifecycle += 1;
      inFlight = null;
    },
  };
}

export async function reloadAdminWithTrash<T>(
  reloadAdmin: () => Promise<TrashOperationResult<T>>,
  loadTrash: () => Promise<TrashOperationResult<AdminTrashRoom[]>>,
  shouldLoadTrash: () => boolean,
): Promise<TrashOperationResult<T>> {
  const reloaded = await reloadAdmin();
  if (!reloaded.ok || !shouldLoadTrash()) return reloaded;
  const trash = await loadTrash();
  return trash.ok ? reloaded : trash;
}

export async function completeTrashWrite(
  write: () => Promise<
    { ok: true; confirm: () => void } | { ok: false; error?: unknown }
  >,
  reload: () => Promise<TrashOperationResult<unknown>>,
) {
  const result = await write();
  if (!result.ok) return false;
  const reloaded = await reload();
  if (!reloaded.ok) return false;
  result.confirm();
  return true;
}

export function formatTrashCountdown(purgeAfter: string, nowMs: number) {
  const purgeAfterMs = Date.parse(purgeAfter);
  if (!Number.isFinite(purgeAfterMs) || !Number.isFinite(nowMs))
    return "删除时间未知";
  const remaining = purgeAfterMs - nowMs;
  if (remaining <= 0) return "等待自动删除";
  if (remaining < 3_600_000) return "剩余不足 1 小时";
  return `剩余 ${Math.ceil(remaining / 3_600_000)} 小时`;
}

export function formatTrashDeadline(purgeAfter: string) {
  const deadline = new Date(purgeAfter);
  if (!Number.isFinite(deadline.getTime())) return "删除时间未知";
  return deadline.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
