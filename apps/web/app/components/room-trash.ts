export type AdminTrashRoom = {
  id: string;
  name: string;
  code: string;
  status: "LOBBY" | "ENDED" | "FINISHED" | "CLOSED";
  deletedAt: string;
  purgeAfter: string;
  deletedBy: { id: string; displayName: string } | null;
};

export function formatTrashCountdown(purgeAfter: string, nowMs: number) {
  const remaining = Date.parse(purgeAfter) - nowMs;
  if (remaining <= 0) return "等待自动删除";
  if (remaining < 3_600_000) return "剩余不足 1 小时";
  return `剩余 ${Math.ceil(remaining / 3_600_000)} 小时`;
}

export function formatTrashDeadline(purgeAfter: string) {
  return new Date(purgeAfter).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
