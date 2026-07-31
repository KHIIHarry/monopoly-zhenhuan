# 账本交易时间与倒序展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在玩家和银行的账本中显示交易金额及 `7月31日 14:30` 格式的交易时间，并将最新记录固定在顶部。

**Architecture:** `LedgerEntry.createdAt` 已由不可变数据库账本保存，`PrismaGameService.snapshot` 已按它降序获取记录，因此无需修改数据库或 API 查询。前端快照类型接收可选时间，使用一个小型格式化函数安全输出中文月日和时分；共享 `Ledger` 组件直接渲染服务端降序列表，覆盖玩家紧凑列表、玩家完整账本及银行房间账本。

**Tech Stack:** TypeScript, React/Next.js, Vitest。

## Global Constraints

- 不新增数据库字段、Prisma 迁移或新的交易时间来源。
- 使用账本已有的 `LedgerEntry.createdAt` 作为唯一权威交易时间。
- 时间显示格式固定为 `7月31日 14:30`，不显示秒。
- 不带时间的旧测试夹具不显示空标签或 `Invalid Date`。
- 账本保持由服务端 `createdAt desc` 决定的从新到旧顺序。

---

### Task 1: 账本时间展示与倒序渲染

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:83-89,437,7430-7463`
- Modify: `apps/web/app/components/app-router-client.test.ts`

**Interfaces:**
- Consumes: 房间快照中的 `ledger: Array<{ id, playerId, type, description, amount, createdAt? }>`；服务端已经按 `createdAt desc` 返回。
- Produces: `formatLedgerTime(createdAt?: string): string | null`，并使共享 `Ledger` 在玩家和银行的三个调用点均按时间倒序显示。

- [ ] **Step 1: 写出前端契约的失败测试**

在 `apps/web/app/components/app-router-client.test.ts` 末尾新增：

```ts
describe('ledger transaction time', () => {
  test('keeps server-newest ledger entries first and renders a second-free timestamp', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/type LedgerEntry = \{[\s\S]*?createdAt\?: string;/);
    expect(component).toMatch(/function formatLedgerTime\(createdAt\?: string\): string \| null/);
    expect(component).toMatch(/month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false/);
    expect(component).toMatch(/const visible = entries;/);
    expect(component).toMatch(/const transactionTime = formatLedgerTime\(entry\.createdAt\);/);
    expect(component).toMatch(/<time dateTime=\{entry\.createdAt\}>\{transactionTime\}<\/time>/);
  });
});
```

- [ ] **Step 2: 运行该测试，确认它因缺少时间展示和仍在反转数组而失败**

Run: `npm test -- apps/web/app/components/app-router-client.test.ts`

Expected: FAIL，断言找不到 `createdAt`、`formatLedgerTime`、`const visible = entries` 或 `<time>` 渲染。

- [ ] **Step 3: 实现账本时间字段、格式化函数和降序渲染**

在 `apps/web/app/components/app-router-client.tsx` 的 `LedgerEntry` 类型中新增可选字段：

```ts
  createdAt?: string;
```

在 `formatMoney` 旁新增安全格式化函数：

```ts
function formatLedgerTime(createdAt?: string): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
```

在 `Ledger` 中将：

```ts
const visible = [...entries].reverse();
```

替换为：

```ts
const visible = entries;
```

将现有 `Ledger` 组件替换为以下完整实现：

```tsx
function Ledger({
  entries,
  players,
  compact = false,
}: {
  entries: LedgerEntry[];
  players?: Player[];
  compact?: boolean;
}) {
  const visible = entries;
  return (
    <div className={`ledger ${compact ? "compact-ledger" : ""}`}>
      {visible.length ? (
        visible.map((entry) => {
          const transactionTime = formatLedgerTime(entry.createdAt);
          const playerName = players?.find((player) => player.id === entry.playerId)?.name;
          return (
            <div key={entry.id}>
              <span className={entry.amount >= 0 ? "money plus" : "money"}>
                {entry.amount >= 0 ? "+" : ""}
                {formatMoney(entry.amount)}
              </span>
              <div>
                <strong>{entry.description}</strong>
                <small>
                  {playerName ? `${playerName} · ` : ""}
                  {entry.type}
                  {transactionTime ? (
                    <>
                      {" · "}
                      <time dateTime={entry.createdAt}>{transactionTime}</time>
                    </>
                  ) : null}
                </small>
              </div>
            </div>
          );
        })
      ) : (
        <div className="empty no-margin">暂无交易记录</div>
      )}
    </div>
  );
}
```

保持 `Ledger` 的三个既有调用点不变：它们共享该组件，因而均获得金额、时间和最新置顶的行为。

- [ ] **Step 4: 运行针对性测试，确认通过**

Run: `npm test -- apps/web/app/components/app-router-client.test.ts`

Expected: PASS，包含新增的 `ledger transaction time` 测试。

- [ ] **Step 5: 执行类型检查与完整单元测试**

Run: `npm run typecheck && npm test`

Expected: 两条命令均以退出码 0 完成。

- [ ] **Step 6: 提交实现**

```bash
git add apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts
git commit -m "feat: show transaction times in ledgers"
```
