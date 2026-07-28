# 最小实时房间同步设计

## 状态与权威

本文件由 2026-07-28 的最新产品决定取代同日早先批准的“方案 3”设计。早先设计中的 `RealtimeOutbox`、dispatcher、Session admission gate、pending registry、process epoch presence、独立 Socket/前端 coordinator 和 Redis 均已明确取消，不得继续实现。

账号、房间成员、人物/银行能力、控制权、资产、幂等和结算规则仍以 `甄嬛传大富翁_新版账号房间开发文档.md` V2.1 为唯一产品依据。本文件只增加最小实时通知与恢复规则。

实施任务以 [最小实时通信实施检查清单](../plans/2026-07-28-realtime-room-sync.md) 为准。

## 部署边界

- 当前生产拓扑固定为一个 API 进程、PostgreSQL、Socket.IO 默认内存 Adapter 和一个 Web 进程。
- 不使用 Redis。未来增加 API 副本前，必须另行设计并引入共享 Socket.IO Adapter；当前配置不得直接扩容 API。
- HTTPS/WSS 是生产必需条件，因为 Session Cookie 始终为 `Secure`。

## 认证与隔离

- HTTP 与 Socket.IO 都只使用 `zhenhuan_session` HttpOnly Cookie，不接受 Bearer Token、设备令牌或 Socket Token。
- Socket.IO 在连接 middleware 中校验 Session；订阅房间时再次校验 Session、活动成员关系和 `activeSessionId` 控制权。
- 每个 Socket 保留 `session:<sessionId>` 会话通道，并至多加入一个 `room:<roomId>` 业务通道。新授权订阅替换旧业务通道；失败后保持无业务通道。
- 房间通知只发往对应 `room:<roomId>`，不得全局广播或携带其他房间数据。

## 权威状态与版本

- PostgreSQL 和现有业务事务是唯一可信来源；Socket.IO 只发送失效通知，不承载余额、地产、回合或审批的最终状态。
- `Room.stateVersion` 是简单递增整数。核心房间写事务实际提交时在同一事务内加一；失败和幂等重放不加一。
- seats、游戏 snapshot 和 settlement REST 响应返回 `stateVersion`。失效通知只需要 `{ roomId, stateVersion }`。
- 客户端只提交当前房间且版本不低于已接受版本的响应；旧通知和旧 REST 响应不得覆盖新状态。

## 刷新与恢复

- 客户端连接/重连、网络恢复、`pageshow`、页面重新可见和收到本房间失效通知时，重新拉取完整权威 REST 状态。
- GAME/FINISH 优先读取完整 snapshot；只有控制权或能力已变化时读取一次 seats 并重新路由。
- 不使用定时轮询、超时重试循环或断线增量补包作为主要同步方式。
- Socket 断线不释放人物或银行席位；恢复后沿用现有成员和 Player。

## 会话撤销

- 退出最早设备、退出其他设备、指定设备退出、重置密码和禁用账号都必须得到本次实际撤销的 Session ID。
- 数据库事务提交后，服务端向每个 `session:<sessionId>` 发送 `account.session.revoked`，随即强制断开该通道的 Socket。
- 客户端收到撤销事件立即清理账号态并返回登录页；撤销后的任何 REST 请求仍由服务端返回 Session 失效。

## 验收范围

只以这六条路径作为本次实时扩展的完成条件：银行 + 两玩家同步、双房间隔离、重连完整恢复、旧版本拒绝、强退立即失效、重复请求不重复改变资金或资产。只修复 Critical/Important 缺陷，不因理论极端时序增加新抽象。
