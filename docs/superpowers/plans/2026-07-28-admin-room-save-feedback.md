# 房间配置保存反馈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让房间管理配置在服务端回读确认后再提示已保存并生效。

**Architecture:** 保持现有保存接口不变，在 `AdminView` 中为房间配置保存维护局部状态。写入后由已有的 `refreshRoom` 获取权威详情，并将提交字段与权威配置作比较。

**Tech Stack:** Next.js、React、Playwright、Vitest。

## Global Constraints

- 不修改 API 或数据库契约。
- 成功状态必须由保存后的详情回读确认。
- 保留现有幂等请求机制。

---

### Task 1: 房间配置保存回归测试

**Files:**
- Modify: `tests/e2e/task7-management.spec.ts`

- [ ] **Step 1: Write the failing test**

新增一个管理员房间管理用例：将 `initialBalance` 改为 `6800`，提交 `PATCH /api/admin/rooms/room-1`，使后续详情 GET 返回 `6800`；断言按钮先显示“正在保存”，随后显示“已保存并生效”，并断言重新打开详情仍为 `6800`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:e2e -- --grep "管理员房间配置在回读后确认保存"`

- [ ] **Step 3: Implement the minimal UI state and verification**

在 `AdminView` 中保存提交快照，调用现有写入与刷新逻辑。详情回读成功且快照字段完全一致时设置成功状态；在保存中禁用按钮并显示 `LoaderCircle`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:e2e -- --grep "管理员房间配置在回读后确认保存"`

### Task 2: 保存反馈视觉状态

**Files:**
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Add success feedback styling**

添加仅用于房间配置的状态提示和短暂成功动画，使用现有色彩和 `spin` 动画约定；成功文本为“已保存并生效”。

- [ ] **Step 2: Run focused regression suite**

Run: `npm run test:e2e -- --grep "房间配置|complete Task 6"`

- [ ] **Step 3: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
