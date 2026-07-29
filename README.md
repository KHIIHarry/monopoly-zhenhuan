# 甄嬛传大富翁 H5

面向实体桌游的移动端数字伴侣。系统管理账号、房间、人物与银行席位、余额账本、26 块地产、审批、2d6 电子骰子、停轮、人物技能、角色交换和不可变结算；实体棋子位置和未结构化卡牌仍由现场裁定。

## 技术架构

- npm workspaces monorepo
- Next.js + React + TypeScript H5
- Fastify + Socket.IO API
- PostgreSQL + Prisma
- Zod、Vitest、Playwright

PostgreSQL 是唯一持久化状态来源。资金、产权、审批、回合、结算和幂等记录都在现有 Prisma 事务中提交。Socket.IO 只向房间发送版本化失效通知，H5 随后用 HttpOnly Cookie 拉取完整 REST 快照；不使用前端定时轮询或 Socket 事件负载决定最终余额、地产和回合。

当前部署只支持一个 API 进程和 Socket.IO 默认内存 Adapter，不使用 Redis。

## 使用流程

```text
首页海报
→ 加入游戏组
→ 账号登录
→ 房间列表
→ 加入房间（必要时验证密码）
→ 选择五名人物之一或银行
→ 进入玩家端或银行端
```

- 账号只能由超级管理员创建，没有游客、自助注册或观战入口。
- 昵称来自 `Account.displayName`；浏览器不保存 Bearer Token、Socket Token 或临时角色身份。
- 一个账号最多有两个有效 Session。第 3 台设备必须明确选择“退出最早登录设备并继续”。
- 同一账号在一个房间只有一条 `RoomMembership` 和一个活动控制 Session；第二台设备可接管，旧设备立即失去该房间操作权。
- 人物能力和银行能力可由同一成员兼任，但人物 Player、资金和资产只有一份。
- 离线不会释放人物或银行席位。

## 统一转帐

- 玩家端“转帐”可选择其他人物玩家或银行作为收款对象；收款人使用人物卡片选择，付款人本人不会出现在列表中。
- 建房时的“玩家转帐需要审批”决定两类收款对象是否进入银行审批。未勾选时事务立即结算；勾选时先生成待审批请求，批准后才结算，拒绝不改变余额。
- 银行是独立身份，不拥有余额账户。玩家向银行转帐时只扣减玩家余额，并写入不可删除账本；不会虚构银行余额或给银行 Player 账户加款。
- 沈眉庄勾选剧情罚款后，前端提交剧情卡原始金额。服务端按当前房间的人物技能配置计算减免和实际金额，玩家转给银行、玩家转给其他人物以及银行端录入剧情罚款共用同一计算逻辑。
- 转帐提交和审批都使用 `Idempotency-Key`；余额校验、付款、收款、请求状态和账本记录在同一 PostgreSQL 事务中提交。

## Session 与 Cookie

登录使用服务端 Session，数据库只保存随机令牌的哈希。Cookie 名为 `zhenhuan_session`，默认 30 天，并始终设置：

- `HttpOnly`
- `Secure`
- `SameSite=Lax`

HTTP 和 Socket.IO 都只从该 Cookie 认证。退出最早设备、退出其他设备、指定设备退出、重置密码和禁用账号会撤销对应 Session，立即向 `session:<sessionId>` 发送 `account.session.revoked` 并强制断开 Socket；后续 REST 请求仍会被服务端拒绝。

## 实时同步

- 每个 Socket 保留一个 Session 通道，并至多订阅一个最新授权的 `room:<roomId>` 业务通道。
- `Room.stateVersion` 在实际提交的核心房间事务中原子递增；失败事务和幂等重放不递增。
- 房间通知携带 `{ roomId, stateVersion }`，不携带可作为最终状态使用的资金或资产数据。
- seats、游戏 snapshot 和 settlement REST 响应返回 `stateVersion`；H5 拒绝旧版本响应覆盖新版本。
- 连接/重连、网络恢复、`pageshow`、页面重新可见和收到本房间通知时，H5 重新拉取完整权威状态。
- 断线期间不依赖补收增量事件；恢复总是以 REST 完整快照为准。

## 本地启动

要求 Node.js 22+、npm 10+、Docker 和系统 Google Chrome（桌面 Chromium Playwright 项目使用 `channel: chrome`）。

```bash
cp .env.example .env
set -a
. ./.env
set +a

docker compose up -d postgres
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

访问：

- H5：`http://localhost:3000`
- API：`http://localhost:4000/health`

Cookie 为 `Secure`。本地认证测试请统一使用 `localhost` 页面和 API，不要混用 `localhost` 与 `127.0.0.1`。

如果本机 5432 已占用：

```bash
export POSTGRES_PORT=55432
export DATABASE_URL='postgresql://zhenhuan:zhenhuan@localhost:55432/zhenhuan?schema=public'
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

## 超管初始化

seed 只在显式提供以下变量时幂等创建首个超级管理员：

```bash
export BOOTSTRAP_ADMIN_USERNAME='admin'
export BOOTSTRAP_ADMIN_PASSWORD='<至少 8 位的强密码>'
export BOOTSTRAP_ADMIN_DISPLAY_NAME='超级管理员'
npm run db:seed
```

之后由该账号在 H5 超管后台创建普通账号、设置 `canCreateRoom`、管理设备和房间。系统不使用超管 Bearer Token 或银行授权码。

## Migration 与 seed

部署和升级固定按以下顺序运行：

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
```

Prisma schema 和 forward-only migrations 位于 `packages/database/prisma/`。seed 从 `甄嬛传大富翁_master-data.json` 校验并写入 26 块地产和五名人物；不会通过清空数据库处理兼容问题。

## 生产部署

本项目可完全通过 Docker Compose 部署：宿主机只需要 Docker、Docker Compose 插件、域名和 TLS 证书，不需要安装 Node.js、npm 或 PostgreSQL。

### 部署前提

- 一台可被公网访问的 Linux 服务器；DNS 中的域名 A/AAAA 记录已经指向该服务器。
- 已安装 Docker Engine 和 Docker Compose 插件。安装方式请使用 [Docker 官方文档](https://docs.docker.com/engine/install/)；安装后执行 `docker compose version` 确认可用。
- 防火墙或云安全组允许 TCP `80` 和 `443` 入站。不要将 `3000`、`4000` 或 `5432` 暴露到公网。
- 已准备与域名匹配的 TLS 证书和私钥文件。当前配置会挂载已有证书，不会自动申请或续期证书。

### 服务组成

`docker-compose.prod.yml` 会启动以下服务：

| 服务 | 作用 | 对外端口 |
| --- | --- | --- |
| `postgres` | PostgreSQL 16 持久化数据库 | 无 |
| `migrate` | 一次性执行数据库迁移与初始化数据 | 无 |
| `api` | Fastify REST API 与 Socket.IO | 无 |
| `web` | Next.js H5 | 无 |
| `nginx` | HTTPS 入口，代理 H5、`/api/` 与 `/socket.io/` | `80`、`443` |

数据库数据保存在 Docker 命名卷 `postgres_data`。`postgres`、`api` 和 `web` 只在内部 Docker 网络中可见；只有 Nginx 会发布宿主机端口。

### 服务器准备

以下示例以 `/opt/zhenhuan-monopoly` 保存项目源码、`/secure` 保存生产密钥为例。路径可自行调整，但环境文件和 TLS 文件不得提交到仓库。

```bash
sudo mkdir -p /opt
cd /opt
sudo git clone <repository-url> zhenhuan-monopoly
sudo chown -R "$USER" /opt/zhenhuan-monopoly

sudo install -d -m 700 /secure
sudo install -d -m 700 /secure/backups
```

将证书和私钥复制或挂载到宿主机的固定绝对路径。例如使用 Certbot 时通常为：

```text
/etc/letsencrypt/live/game.example.com/fullchain.pem
/etc/letsencrypt/live/game.example.com/privkey.pem
```

Docker 守护进程必须有读取这两个文件的权限。证书更新后，执行下文的 Nginx 重启命令以加载新证书。

### 生产环境文件

创建受保护的 `/secure/zhenhuan.prod.env`。替换所有示例密码、域名和证书路径；不要使用尖括号中的示例文本作为实际值。

```bash
sudo touch /secure/zhenhuan.prod.env
sudo chmod 600 /secure/zhenhuan.prod.env
sudoedit /secure/zhenhuan.prod.env
```

文件内容如下。`DATABASE_URL` 中的数据库密码必须与 `POSTGRES_PASSWORD` 相同；如果密码包含 `@`、`:`、`/`、`?`、`#` 或 `%`，必须先进行 URL 编码。`APP_ORIGIN` 和 `NEXT_PUBLIC_API_URL` 必须使用同一个公网 HTTPS 地址，且不带末尾斜杠。

```dotenv
POSTGRES_DB=zhenhuan
POSTGRES_USER=zhenhuan
POSTGRES_PASSWORD=replace-with-a-strong-database-password
DATABASE_URL=postgresql://zhenhuan:replace-with-a-strong-database-password@postgres:5432/zhenhuan?schema=public

APP_ORIGIN=https://game.example.com
NEXT_PUBLIC_API_URL=https://game.example.com

BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-strong-bootstrap-password
BOOTSTRAP_ADMIN_DISPLAY_NAME=超级管理员
SUPER_ADMIN_USERNAMES=admin

TLS_CERT_PATH=/etc/letsencrypt/live/game.example.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/game.example.com/privkey.pem
```

`migrate` 服务会在首次启动和每次需要重新创建服务时执行 Prisma migration 与幂等 seed。首次超管仅在提供 `BOOTSTRAP_ADMIN_*` 变量时创建；完成部署后，请通过 H5 超管后台创建其他账号。

### 首次部署

在项目目录中构建镜像并启动服务：

```bash
cd /opt/zhenhuan-monopoly

docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml build
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml up -d
```

首次构建会下载基础镜像并构建 Next.js 与 API，耗时取决于服务器网络和性能。`migrate` 完成后，`api` 才会启动；随后 Nginx 代理前端和后端服务。

### 部署验证

先确认所有长期服务均为运行状态，且 `migrate` 已成功退出：

```bash
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml ps
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml logs --tail=100 migrate api web nginx
curl --fail https://game.example.com/api/health
```

健康检查应返回成功状态。然后用浏览器打开 `https://game.example.com`，验证登录、一个 API 请求以及实时房间更新。若服务未启动，先查看对应日志；不要通过直接访问 `:3000`、`:4000` 或 `:5432` 排障，因为生产 Compose 不发布这些端口。

### 日常操作

查看服务状态或追踪日志：

```bash
cd /opt/zhenhuan-monopoly
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml ps
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml logs -f api
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml logs -f nginx
```

重启单个服务，或在证书更新后重新加载 Nginx：

```bash
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml restart api
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml restart nginx
```

停止应用但保留数据库数据：

```bash
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml down
```

不要执行 `docker compose down -v`，除非确认要永久删除 `postgres_data` 中的生产数据。

### 升级与回退

每次升级前先创建数据库备份。拉取已经审查过的源码版本后，重新构建并以后台方式更新服务：

```bash
cd /opt/zhenhuan-monopoly
git pull --ff-only
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml build
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml up -d
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml ps
curl --fail https://game.example.com/api/health
```

代码回退可以检出上一份已验证的 Git 提交，再次执行构建与 `up -d`。数据库迁移是 forward-only：如果新版本已执行迁移，不能仅依靠代码回退恢复旧数据库结构；需要使用升级前创建的备份，并在维护窗口内制定单独的恢复方案。

### 数据库备份

以下命令将逻辑备份写入宿主机 `/secure/backups`。执行前确认该目录有足够空间，并将备份复制到独立且受保护的存储位置。

```bash
cd /opt/zhenhuan-monopoly
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > /secure/backups/zhenhuan-$(date +%F-%H%M%S).sql
```

恢复数据库会覆盖现有生产数据，因此本文不提供可直接执行的恢复命令。恢复前必须停止相关写入、确认目标备份、评估迁移版本，并在隔离环境演练。

### 运行限制

- Nginx 将 HTTP 重定向到 HTTPS，并代理 `/api/` 与支持 Upgrade 的 `/socket.io/`。
- API 必须始终保持一个副本。项目使用 Socket.IO 默认内存 Adapter；在引入共享 Adapter（例如 Redis）前不得扩容 API。
- PostgreSQL 命名卷是唯一持久化数据位置；容器重建不会清除数据，但删除卷会。
- `docker-compose.prod.yml` 依赖宿主机 TLS 文件。证书获取、续期和备份调度由运维系统负责，不由本项目自动处理。

## API 约定

所有认证请求使用 Cookie。关键写请求必须发送稳定的 `Idempotency-Key`；同一作用域和同一键只有 canonical payload 相同才会重放，改动金额、目标或原因会返回 `IDEMPOTENCY_KEY_REUSED`。

主要路由：

| 范围 | 路由 |
| --- | --- |
| 认证 | `POST /api/auth/login`、`POST /api/auth/login/replace-oldest-session`、`GET /api/auth/me`、`POST /api/auth/logout` |
| 设备 | `GET /api/auth/sessions`、`DELETE /api/auth/sessions/:id`、`POST /api/auth/sessions/logout-others` |
| 房间 | `GET/POST /api/rooms`、`POST /api/rooms/:id/join`、`GET /api/rooms/:id/seats` |
| 席位 | `POST /api/rooms/:id/select-character`、`select-bank`、`take-control`、角色交换路由 |
| 快照 | `GET /api/rooms/:id/snapshot?view=PLAYER|BANK`、`GET /api/rooms/:id/settlement` |
| 游戏 | 现有落点、请求、审批、转帐、地产、骰子、回合、银行修正和补偿撤销路由 |
| 结算 | `POST /api/rooms/:id/settlement/preview`、`POST /api/rooms/:id/finish` |
| 超管 | `/api/admin/accounts`、设备撤销、房间管理、强制结算、看板和安全日志 |

统一转帐使用 `POST /api/rooms/:id/transfers`。玩家收款请求体为 `{ fromPlayerId, recipientType: "PLAYER", toPlayerId, amount, isPlotFine }`；银行收款请求体为 `{ fromPlayerId, recipientType: "BANK", amount, isPlotFine }`。`amount` 始终是正整数原始金额，服务端返回或在银行快照中提供 `originalAmount`、`reduction` 和 `actualAmount`。

错误统一为 `{ "error": "RULE_CODE" }`。客户端按错误码显示明确提示；未知内部异常不向浏览器泄露堆栈或数据库信息。

## 数据一致性

- AccountRoom 的房间级写入与加入房间使用 `ReadCommitted + Room FOR UPDATE`；建房、结算、跨行一致性流程和游戏资金/资产事务保留 `Serializable` 与有限冲突重试。
- 资金扣减使用条件更新，产权使用数据库约束/版本校验，关键请求使用持久化幂等记录。
- 每次资金变化写入账本；历史账本、审计、安全日志和结算快照受不可变约束保护。
- 角色交换只改变人物及技能绑定，不改变余额、地产、建筑、停轮或历史。
- 结算财富、抵押净值、建筑出售价值、排名与并列冠军使用持久化快照，不受后续 Master Data 修改影响。

## 测试

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

PostgreSQL 集成测试必须使用独立数据库，数据库名以 `_test` 结尾；如果同时设置 `DATABASE_URL`，测试数据库不得解析为同一主机、端口和数据库名。测试会创建隔离 schema，不能把开发或生产库配置为 `TEST_DATABASE_URL`。

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@localhost:55432/zhenhuan_test?schema=public' \
npm run test:integration
```

真实 Cookie/API/PostgreSQL Playwright 门禁额外要求 `TASK7_REAL_STACK=1`、显式测试账号前缀/密码、`*_test` 数据库、`task7_real_*` 临时 schema，以及 `NEXT_PUBLIC_API_URL=http://localhost:4000`。详细保护条件见 `tests/e2e/task7-real-stack.spec.ts`。

已知边界见 [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md)，迁移说明见 [MIGRATION_NOTES_V2.md](./MIGRATION_NOTES_V2.md)，本次最小实时检查清单见 [2026-07-28-realtime-room-sync.md](./docs/superpowers/plans/2026-07-28-realtime-room-sync.md)。
