export type ToastTone = 'SUCCESS' | 'REJECTED';
export type ToastItem = { id: string; message: string; tone: ToastTone };
export type ToastInput = { id?: string; message: string; tone?: ToastTone };

type Schedule = (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
type Cancel = (timer: ReturnType<typeof setTimeout>) => void;

export function createToastQueue(
  onChange: (toast: ToastItem | null) => void,
  schedule: Schedule = globalThis.setTimeout.bind(globalThis),
  cancel: Cancel = globalThis.clearTimeout.bind(globalThis),
) {
  const pending: ToastItem[] = [];
  const seen = new Set<string>();
  let active: ToastItem | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let localId = 0;
  let disposed = false;

  const showNext = () => {
    timer = null;
    active = pending.shift() ?? null;
    onChange(active);
    if (active) timer = schedule(showNext, 3_000);
  };

  const enqueue = (input: ToastInput) => {
    if (disposed) return false;
    const id = input.id ?? `local:${++localId}`;
    if (seen.has(id)) return false;
    seen.add(id);
    pending.push({ id, message: input.message, tone: input.tone ?? 'SUCCESS' });
    if (!active) showNext();
    return true;
  };

  const clear = () => {
    const hadItems = active !== null || pending.length > 0;
    if (timer) cancel(timer);
    timer = null;
    active = null;
    pending.length = 0;
    seen.clear();
    if (hadItems) onChange(null);
  };

  const dispose = () => {
    if (disposed) return;
    clear();
    disposed = true;
  };

  return {
    enqueue,
    current: () => active,
    clear,
    dispose,
  };
}
