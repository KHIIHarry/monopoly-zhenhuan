# 账号与房间体系 V2.1 Implementation Plan

> **For agentic workers:** 按任务顺序使用 TDD 执行；每个任务先运行定向失败测试，再写最小实现，最后运行全量检查。

**Goal:** 把旧版房间码、临时设备身份入口替换为超管创建账号、Cookie Session、房间大厅、人物与银行可兼任的唯一成员关系、单设备房间控制权、角色交换和不可变结算。

**Architecture:** 保留现有 Next.js、Fastify、Prisma、Socket.IO 和已验证的资金/地产/骰子事务。`RoomMembership.characterId` 与 `RoomMembership.isBank` 是可同时存在的能力；`Player` 只在首次取得人物时创建一次。游戏写接口在进入原有业务事务前统一校验 Cookie Session、`activeSessionId` 和所需能力；WebSocket 只发送失效事件，客户端收到后重新拉取 REST 快照。

**Tech Stack:** TypeScript、Next.js、Fastify、PostgreSQL、Prisma、Socket.IO、Zod、Node.js `crypto.scrypt`、Vitest、Playwright。

## Global Constraints

- 账号只能由超级管理员创建；不提供注册、游客、观战、自助找回密码。
- 登录 Session 默认 30 天，Cookie 必须为 HttpOnly、Secure、SameSite=Lax，数据库只存 Token Hash。
- 同账号最多 2 个有效 Session；替换最早 Session 必须在 Serializable 事务内原子完成。
- 同一房间同一账号只有一条成员关系；一条成员关系最多1个人物，并可同时 `isBank=true`。
- 选择人物必须保留 `isBank`，选择银行必须保留 `characterId`；兼任不得创建第二个 Player、资金或资产。
- 同一角色和唯一活动银行席位都由数据库唯一约束兜底。
- 所有游戏写接口必须校验当前 Session 等于成员的 `activeSessionId`。
- 玩家写接口额外要求 `characterId` 和对应 Player；银行写接口额外要求 `isBank=true`。
- WebSocket 只通知，重连后重新拉取快照。
- Master Data 数值不修改；财富使用土地售价、抵押价、建筑出售价的持久化快照。
- 关键写请求继续要求 `Idempotency-Key`，余额和产权继续使用数据库事务及账本。

---

### Task 1: 数据模型与旧数据迁移

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Preserve: `packages/database/prisma/migrations/202607260006_account_room_v2/migration.sql`
- Create: `packages/database/prisma/migrations/202607270007_dual_role_capabilities/migration.sql`
- Modify: `packages/database/src/seed.ts`
- Test: `packages/database/src/database-contract.test.ts`

**Interfaces:**
- Produces: `Account`、`AccountSession`、`RoomMembership`、`RoleSwapRequest`、`GameSettlement`、`SettlementPlayer`、`SecurityLog`。
- Produces: `RoomMembership.characterId/isBank/activeSessionId`、`Room.passwordHash`、`Room.createdByAccountId` 和房间配置字段。

- [ ] 添加 Schema 约束和关系，删除成员的互斥 `role` 与设备令牌字段，并让 `RoomMembership` 继续映射旧 `RoomMember` 表以保留账本外键。
- [ ] 保留 006 的账号/Session 基础迁移，并用 007 把旧 `role` 数据转换为 `characterId + isBank`、删除设备身份列和修正约束。
- [ ] 添加 `(roomId, accountId)`、`(roomId, characterId)` 唯一约束，以及 `WHERE isBank=true AND status='ACTIVE'` 的银行部分唯一索引。
- [ ] 扩展 seed：设置五人物技能和初始宫殿；仅在提供 bootstrap 环境变量时幂等创建首个超管账号。
- [ ] 运行 `npm run db:generate && npm run typecheck`，预期通过。

### Task 2: 密码、Cookie 与 2 设备 Session

**Files:**
- Create: `apps/api/src/auth-domain.ts`
- Create: `apps/api/src/auth-domain.test.ts`
- Create: `apps/api/src/account-room-service.ts`
- Create: `apps/api/src/account-room-service.integration.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/api-error.ts`

**Interfaces:**
- Produces: `hashPassword(password)`、`verifyPassword(password, encoded)`、`sessionCookie(token, secure)`、`clearSessionCookie(secure)`。
- Produces: `AccountRoomService.login`、`replaceOldestSession`、`authenticate`、`listSessions`、`revokeSession`、`logoutOthers`。

- [ ] 先测试 scrypt 密码验证、篡改失败、30 天 Cookie 属性和 IP 脱敏。
- [ ] 用 Node.js `crypto.scrypt` 实现带随机盐、定时安全比较的密码哈希，不增加依赖。
- [ ] 在 Serializable 事务内统计有效 Session；第 3 台返回 `SESSION_LIMIT_REACHED` 和两台摘要，不创建 Session。
- [ ] `replaceOldestSession` 重新验证密码，撤销最早 Session、创建新 Session、写 `SecurityLog`。
- [ ] 密码重置与账号禁用同时撤销全部 Session；认证每次检查账号状态、有效期和撤销时间。
- [ ] 实现认证、设备管理与退出接口，并运行定向测试。

### Task 3: 房间大厅、密码、双能力席位与控制权

**Files:**
- Modify: `apps/api/src/account-room-service.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/account-room-service.integration.test.ts`

**Interfaces:**
- Produces: `listRooms(accountId)`、`createRoom(account, input)`、`joinRoom(account, roomId, password)`、`seats(roomId)`、`selectCharacter`、`selectBank`、`takeControl`。
- Consumes: 任务 2 的 `authenticate` 返回 `{ account, session, rawToken }`。

- [ ] 测试无创建权限账号被拒绝、有权限账号可建房、密码错误与已加入免重复验证。
- [ ] 创建房间时哈希可选密码，列表只返回 `hasPassword`。
- [ ] 加入只建立无席位 Membership；显示名只复制 `Account.displayName`。
- [ ] 选人物事务只设置 `characterId` 并保留 `isBank`；首次取得人物时创建唯一 Player、初始资金账本和初始宫殿。
- [ ] 已有人物再次直选返回 `ACCOUNT_CHARACTER_LIMIT_REACHED`；唯一人物冲突返回 `ROLE_ALREADY_TAKEN`。
- [ ] 选银行事务只设置 `isBank=true` 并保留 `characterId`/Player；银行唯一冲突返回 `BANK_ALREADY_TAKEN`。
- [ ] 两种选择顺序都只保留一条 Membership 和至多一条 Player；离线和 Session 撤销不释放席位。
- [ ] `takeControl` 原子更新 `activeSessionId` 并发送 `room.control.changed`。

### Task 4: 游戏写权限与角色交换

**Files:**
- Modify: `apps/api/src/prisma-game-service.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/account-room-service.ts`
- Test: `apps/api/src/prisma-game-service.integration.test.ts`
- Test: `apps/api/src/account-room-service.integration.test.ts`

**Interfaces:**
- Produces: `authorizeRoomSession(roomId, sessionId, expectedCapability?)`，其中能力为 `PLAYER` 或 `BANK`。
- Produces: `requestRoleSwap`、`acceptRoleSwap`、`rejectRoleSwap`、`approveRoleSwapByBank`、`cancelRoleSwap`。

- [ ] 删除匿名 player/bank join、reconnect 和 bearer 设备令牌路由。
- [ ] 所有游戏写路由先校验 Cookie Session、Membership 和 `activeSessionId`；旧设备返回 `ROOM_CONTROL_LOST`。
- [ ] 未开局交换在目标同意时原子完成；已开局进入 `PENDING_BANK`，银行端再次确认后完成。
- [ ] 交换只更新双方 Membership/Player 的 `characterId` 和技能绑定，不修改 `isBank`、余额、地产、建筑、停轮和账本。
- [ ] 兼任银行的申请人或目标仍可完成玩家决定，并可在银行端以独立请求和审计记录确认。
- [ ] 发送席位、角色占用、交换、控制权和 Session 撤销事件；订阅重连只通知客户端拉快照。

### Task 5: 结束游戏与不可变结算

**Files:**
- Create: `apps/api/src/settlement.ts`
- Create: `apps/api/src/settlement.test.ts`
- Modify: `apps/api/src/account-room-service.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/account-room-service.integration.test.ts`

**Interfaces:**
- Produces: `rankSettlementPlayers(players)` 和 `AccountRoomService.previewSettlement/finishRoom/getSettlement`。

- [ ] 测试未抵押地产、抵押净值、建筑出售价值、排名三层 tie-break 和并列冠军。
- [ ] 预览检查待审批、未完成转账/交易、待交换、异常余额、开放债务和未完成回合，返回明确 blockers 与财富明细。
- [ ] 银行必须提交精确短语 `确认结束游戏`；超管强制结束必须有原因。
- [ ] 在同一 Serializable 事务内重新检查 blockers、计算财富、创建快照并把房间设为 `FINISHED`。
- [ ] 仅为有 `characterId` 和 Player 的成员生成一条 SettlementPlayer；银行-only 排除，兼任成员只生成一次。
- [ ] 已结束房间的所有游戏写接口返回 `ROOM_FINISHED`；结算表增加拒绝 UPDATE/DELETE 的触发器。

### Task 6: 超管账号、设备与数据看板

**Files:**
- Modify: `apps/api/src/account-room-service.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/account-room-service.integration.test.ts`

**Interfaces:**
- Produces: 账号 CRUD、重置密码、启禁用、设备强退、房间强制结束和 `dashboard()`。

- [ ] 每个超管写操作校验 `isSuperAdmin` 并写 `SecurityLog`。
- [ ] `canCreateRoom` 与 `isSuperAdmin` 独立更新。
- [ ] 看板使用数据库聚合返回账号、Session、房间、时长、人物选择和获胜统计。
- [ ] 登录 IP 默认脱敏；强退设备后下一次请求立即 401。

### Task 7: H5 新主流程

**Files:**
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `tests/e2e/workbench.spec.ts`

**Interfaces:**
- Consumes: 任务 2-6 的 Cookie API；所有 fetch 使用 `credentials: 'include'`。

- [ ] 删除首页身份切换、房间码/昵称/授权码/超管令牌、恢复身份、Bearer 设备令牌和旧 Session localStorage。
- [ ] 首页只保留海报和“加入游戏组”，之后依次显示登录、房间大厅、密码加入和席位选择。
- [ ] 席位卡显示技能、初始宫殿、占用昵称、已占用和申请交换；进入时总是重新拉取 seats。
- [ ] 增加个人设备页、第 3 台替换确认、房间接管页、交换审批、结算页和超管账号管理/看板。
- [ ] 保留原玩家/银行 Workbench，改用 Cookie 和能力鉴权；兼任成员显示 `玩家端`/`银行端`切换，不创建新 Session 或资产。
- [ ] 房间卡和席位页显示人物、银行及兼任状态；席位页允许人物后兼任银行、银行后选择首个人物。
- [ ] 更新移动端 E2E，断言旧入口文案全部不存在。

### Task 8: 交付与验收

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `KNOWN_LIMITATIONS.md`
- Modify: `MIGRATION_NOTES_V2.md`

- [ ] 写 bootstrap 超管、migration/seed、本地启动、Cookie HTTPS、API 和测试说明。
- [ ] 运行 `npm run lint`，预期 exit 0。
- [ ] 运行 `npm run typecheck`，预期 exit 0。
- [ ] 运行 `npm run test`，预期 exit 0。
- [ ] 运行 `npm run build`，预期 exit 0。
- [ ] 运行定向/完整 Playwright，验证移动端主流程和旧入口删除。
- [ ] 从 `monopoly-zhenhuan/` 启动 API `4000` 与 H5 `3000`，完成桌面和移动端浏览器验收。
