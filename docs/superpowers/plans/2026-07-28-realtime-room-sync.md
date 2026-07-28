# 最小实时通信实施检查清单

**目标：** 在单 API 进程下复用 Socket.IO、Fastify、Prisma 事务、既有幂等记录和 REST 快照，实现最小可用且正确的多人房间同步。

**明确完成时间：** 2026-07-28 22:30 CST（Asia/Shanghai）。

## 硬约束

- [x] Task 7 过时订阅回滚阻断已关闭；定向测试 20/20 通过。
- [x] Socket.IO 只使用 `zhenhuan_session` HttpOnly Cookie 鉴权，不接受 Bearer/Socket Token。
- [x] 每个 Socket 至多加入一个 `room:<roomId>` 业务房间，并保留一个 `session:<sessionId>` 会话房间。
- [x] Socket 事件只发送 `{ roomId, stateVersion }` 失效通知；资金、地产、回合等状态只信任 REST 快照。
- [x] 玩家断线只标记离线，不释放人物或银行席位。
- [x] 不使用 Redis、RealtimeOutbox、dispatcher、session admission gate、pending registry、process epoch presence、独立 coordinator 或新测试框架。

## 1. 数据与事务

- [x] `Room` 增加 `stateVersion Int @default(0)`，提供只增列且保留现有数据的 Prisma migration。
- [x] 既有核心房间写事务成功时原子 `increment: 1`；失败事务不递增。
- [x] 幂等重放返回首次结果及版本，不重复递增、不重复扣款或改变资产。
- [x] 座位、游戏快照和结算 REST 响应返回当前 `stateVersion`。

## 2. Socket 服务端

- [x] 用 Socket.IO middleware 在 `connection` 前校验 Cookie Session；无效/撤销/禁用 Session 拒绝连接。
- [x] `room.subscribe` 每次重新校验账号、成员关系和当前 Session 控制权，再替换唯一业务房间。
- [x] 核心事务提交后向对应 `room:<roomId>` 发送版本化 `room.snapshot-required`。
- [x] 退出最早设备、退出其他设备、重置密码、禁用账号、指定设备退出均返回确切 Session ID；提交后先发 `account.session.revoked`，再强制断开 `session:<sessionId>`。
- [x] 成员移除或控制权转移后让失权 Socket 离开原业务房间；不增加新的协调层。

## 3. H5 客户端

- [x] 删除 80ms `setTimeout` 重试循环，不以轮询作为同步方式。
- [x] 保留页面内一个权威刷新函数：GAME/FINISH 优先读取完整 snapshot；控制权/身份错误时只回退读取一次 seats 并重新路由。
- [x] 在 Socket connect/reconnect、同房间失效通知、`online`、`pageshow`、页面重新 visible 时调用同一刷新函数。
- [x] 按 `{ roomId, stateVersion }` 拒绝旧通知和旧 REST 响应，旧版本不得覆盖新版本。
- [x] 收到 `account.session.revoked` 立即清理登录态并返回登录页。

## 4. 单进程生产部署

- [x] 增加根 `Dockerfile`、`docker-compose.prod.yml`、`deploy/nginx.conf` 和 `.dockerignore`。
- [x] Compose 固定一个 API 服务实例；PostgreSQL/API/Web 仅内网可见，只暴露 Nginx。
- [x] Nginx 正确代理 `/api/` 与 `/socket.io/` Upgrade，并要求 HTTPS/WSS 以兼容 Secure Cookie。
- [x] 生产 CORS 仅允许配置的 HTTPS Origin；不引入 Redis Adapter。

## 5. 仅保留的验收路径

- [x] 1 个银行端和 2 个玩家端在同一房间通过通知 + REST 快照实时同步。
- [x] 两个房间消息完全隔离。
- [x] 断线重连后恢复完整权威状态。
- [x] 旧版本响应不能覆盖新版本。
- [x] 被强退设备立即收到失效并断开。
- [x] 同一幂等请求不会重复扣款或改变资产。

## 完成门槛

- [x] 上述六条验收全部通过；相关 Vitest/Playwright、typecheck、lint、build 通过。
- [x] 两轮独立审查均为 Critical 0 / Important 0；Minor 仅记录，不因此扩展架构。
- [x] 更新 `.superpowers/sdd/progress.md`、README/API/部署说明和已知限制，报告真实未完成项。

**证据：** Socket Vitest 13/13、PostgreSQL 156/156、Cookie Socket Playwright 6/6、真实栈 1/1、全量 Vitest 102/102；generate、lint、typecheck、build、API/Web 镜像运行、Compose 与 Nginx 配置均通过；两轮独立审查均为 Critical 0 / Important 0；桌面和移动浏览器 QA 无溢出、资源或控制台错误。
