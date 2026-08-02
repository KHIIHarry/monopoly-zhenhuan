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

房间的赎回手续费默认为 200 两，支持设置为 0，仅可在创建房间和大厅阶段修改。赎回地产需支付“抵押价 + 赎回手续费”；抵押地产也可无需先赎回而申请卖给银行，卖回金额为 `max(0, 购买价 - 抵押价 - 赎回手续费)`。抵押地产卖回仍需银行审批，批准后恢复无主并清除抵押状态。

## 统一转帐

- 玩家端“转帐”可选择其他人物玩家或银行作为收款对象；收款人使用人物卡片选择，付款人本人不会出现在列表中。
- 建房时的“玩家转帐需要审批”决定两类收款对象是否进入银行审批。未勾选时事务立即结算；勾选时先生成待审批请求，批准后才结算，拒绝不改变余额。
- 银行是独立身份，不拥有余额账户。玩家向银行转帐时只扣减玩家余额，并写入不可删除账本；不会虚构银行余额或给银行 Player 账户加款。
- 沈眉庄勾选剧情罚款后，前端提交剧情卡原始金额。服务端按当前房间的人物技能配置计算减免和实际金额，玩家转给银行、玩家转给其他人物以及银行端录入剧情罚款共用同一计算逻辑。
- 转帐提交和审批都使用 `Idempotency-Key`；余额校验、付款、收款、请求状态和账本记录在同一 PostgreSQL 事务中提交。

## Session 与 Cookie

登录使用服务端 Session，数据库只保存随机令牌的哈希。Cookie 名为 `zhenhuan_session`，默认 30 天，并设置：

- `HttpOnly`
- `SameSite=Lax`
- `Secure`（生产环境和普通 localhost 开发模式；显式局域网 HTTP 模式除外）

HTTP 和 Socket.IO 都只从该 Cookie 认证。退出最早设备、退出其他设备、指定设备退出、重置密码和禁用账号会撤销对应 Session，立即向 `session:<sessionId>` 发送 `account.session.revoked` 并强制断开 Socket；后续 REST 请求仍会被服务端拒绝。

## 实时同步

- 每个 Socket 保留一个 Session 通道，并至多订阅一个最新授权的 `room:<roomId>` 业务通道。
- `Room.stateVersion` 在实际提交的核心房间事务中原子递增；失败事务和幂等重放不递增。
- 房间通知携带 `{ roomId, stateVersion }`，不携带可作为最终状态使用的资金或资产数据。
- seats、游戏 snapshot 和 settlement REST 响应返回 `stateVersion`；H5 拒绝旧版本响应覆盖新版本。
- 连接/重连、网络恢复、`pageshow`、页面重新可见和收到本房间通知时，H5 重新拉取完整权威状态。
- 断线期间不依赖补收增量事件；恢复总是以 REST 完整快照为准。
- `room.toast` 仅作为在线实时提醒，通过 `session:<sessionId>` 按当前玩家端或银行端定向发送；它不替代 REST 快照和不可变资金账本，断线期间也不会补发。

## 本地启动

运行系统只要求 Docker Desktop，或 Docker Engine 与 Compose 插件。宿主机 Node.js、npm 和系统 Google Chrome 仅用于 lint、类型检查、测试与构建，不用于启动 Web 或 API。

```bash
test -f .env || cp .env.example .env
docker compose up -d
docker compose ps
docker compose logs --tail=100 postgres api web
```

首次启动会在容器内安装依赖、生成 Prisma Client、执行 migration、幂等 seed，并构建 API，因此需要等待日志显示 API 已开始监听。不要使用宿主机 `npm run dev`、`npm run start` 或 `npm run dev:lan` 启动服务。

访问：

- H5：`http://localhost:3000`
- API：`http://localhost:4000/health`

默认开发 Cookie 为 `Secure`。本地认证测试请统一使用 `localhost` 页面和 API，不要混用 `localhost` 与 `127.0.0.1`。只有下文显式启用的可信局域网 HTTP 模式会移除 `Secure`，其他 Cookie 安全属性保持不变。

如果本机 5432 已占用：

```dotenv
POSTGRES_PORT=55432
DATABASE_URL=postgresql://zhenhuan:zhenhuan@localhost:55432/zhenhuan?schema=public
```

保存 `.env` 后重新执行 `docker compose up -d`。API 容器始终通过 Compose 内部网络访问 `postgres:5432`；这里的宿主机端口只用于本机数据库工具。

## 局域网 HTTP 启动

该模式只适用于同一可信 Wi-Fi 内的实体桌游设备。先确认主持电脑的 RFC1918 私网 IPv4；以下示例使用 `192.168.31.196`。在 `.env` 中设置：

```dotenv
APP_BIND_ADDRESS=0.0.0.0
LAN_HTTP_ORIGIN=http://192.168.31.196:3000
NEXT_PUBLIC_API_URL=http://192.168.31.196:4000
NEXT_ALLOWED_DEV_ORIGINS=192.168.31.196
```

保留 `POSTGRES_BIND_ADDRESS=127.0.0.1`，不要把数据库开放到局域网。然后只通过 Docker Compose 重建 Web 与 API：

```bash
docker compose up -d --force-recreate api web
docker compose ps
```

玩家手机和平板访问：

```text
http://192.168.31.196:3000
```

局域网模式只允许 `http://192.168.31.196:3000` 这样的精确页面来源访问 API；相邻 IP、其他端口和其他私网来源仍会被拒绝。H5 会自动连接同一电脑的 `4000` 端口，玩家不需要单独打开 API 地址。

使用要求与排障：

- 电脑和所有玩家设备必须处于同一 Wi-Fi，且路由器未启用客户端隔离。
- macOS 防火墙首次询问 Docker Desktop 是否允许入站连接时选择允许。
- 如果休眠、切换 Wi-Fi 或 DHCP 续租造成 IP 地址变化，请更新 `.env` 中的 `LAN_HTTP_ORIGIN`、`NEXT_PUBLIC_API_URL` 和 `NEXT_ALLOWED_DEV_ORIGINS`，再执行 `docker compose up -d --force-recreate api web`，并把新地址发给玩家。
- 需要长期保持地址不变时，在路由器 DHCP 设置中为主持电脑保留地址。
- HTTP 流量未加密，只能用于可信局域网；不得将 `3000`、`4000` 或 `5432` 映射到公网。
- `LAN_HTTP_ORIGIN` 仅用于非生产环境；生产环境设置它会导致 API 拒绝启动。

## 超管初始化

seed 只在 `.env` 显式提供以下变量时幂等创建首个超级管理员：

```dotenv
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=<至少 12 位的强密码>
BOOTSTRAP_ADMIN_DISPLAY_NAME=超级管理员
```

首次 `docker compose up -d` 会自动执行 seed；已运行的环境可执行 `docker compose exec api npm run db:seed` 重新运行幂等 seed。

之后由该账号在 H5 超管后台创建普通账号、设置 `canCreateRoom`、管理设备和房间。系统不使用超管 Bearer Token 或银行授权码。

## 超管离线密码重置

仅当配置中的超级管理员忘记密码、无法登录后台时，可信服务器上的运维人员可交互式重置其密码。执行前必须正确配置 `DATABASE_URL` 和 `SUPER_ADMIN_USERNAMES`；后者只列出用户名，不创建账号，也不应包含空用户名或重复用户名。

命令只接受用户名，绝不接受 `--password` 或其他明文密码参数。它会在可信终端隐藏输入新密码并再次确认；密码长度必须为 8 至 200 个字符。请勿通过 SSH 命令文本、管道、shell 历史、自动化变量或日志传递密码。

开发 Docker Compose 环境：

```bash
docker compose exec api npm run admin:reset-password -- --username admin
```

生产 Docker Compose 环境（在项目目录执行，并使用受保护的生产环境文件）：

```bash
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml \
  run --rm --no-deps --entrypoint node api \
  apps/api/dist/admin-reset-password-cli.js --username admin
```

该操作在一个数据库事务中更新密码哈希、撤销目标账号全部未撤销且未过期的 Session，并写入 `PASSWORD_RESET` 安全日志。日志标记 `OFFLINE_OPERATIONS_CLI`、目标账号 ID、撤销数量和发生时间，但不记录密码或密码哈希。成功后该账号所有现有设备都必须重新登录；建议立即在后台安全日志中核对记录。

离线重置不会创建账号、不会提升普通账号权限、不会启用已禁用账号，也不会修改 `.env` 中的 `BOOTSTRAP_ADMIN_PASSWORD`。修改 bootstrap 密码不能重置既有账号。配置中的超级管理员账号不能通过后台禁用或删除；如历史数据中已有被禁用的超级管理员，请走独立的受控恢复流程，而不是通过密码重置绕过状态保护。

## Migration 与 seed

数据库初始化与升级只随 Docker Compose 执行，不在宿主机直接运行数据库 npm 命令：

- 本地 `docker compose up -d` 由 API 容器依次生成 Prisma Client、部署 migration、执行幂等 seed，再启动 API。
- 生产 `docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml up -d` 先由一次性 `migrate` 容器执行 migration 与 seed；该容器成功退出后 API 才启动。

Prisma schema 和 forward-only migrations 位于 `packages/database/prisma/`。seed 从 `monopoly-zhenhuan_master-data.json` 校验并写入 26 块地产和五名人物；不会通过清空数据库处理兼容问题。

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

sudo install -d -m 700 -o "$USER" -g "$(id -gn)" /secure
sudo install -d -m 700 -o "$USER" -g "$(id -gn)" /secure/backups
```

将证书和私钥复制或挂载到宿主机的固定绝对路径。例如使用 Certbot 时通常为：

```text
/etc/letsencrypt/live/game.example.com/fullchain.pem
/etc/letsencrypt/live/game.example.com/privkey.pem
```

Docker 守护进程必须有读取这两个文件的权限。证书更新后，执行下文的 Nginx 单服务重建命令以重新挂载新证书。

### 生产环境文件

创建受保护的 `/secure/zhenhuan.prod.env`。替换所有示例密码、域名和证书路径；不要使用尖括号中的示例文本作为实际值。

数据库密码和引导管理员密码应分别执行两次 `openssl rand -hex 24` 生成，分别使用两次独立输出。十六进制结果满足密码长度要求，也不会被 Compose 当作变量插值。

```bash
openssl rand -hex 24
openssl rand -hex 24
```

```bash
test -f /secure/zhenhuan.prod.env || sudo install -m 600 -o "$USER" -g "$(id -gn)" /dev/null /secure/zhenhuan.prod.env
nano /secure/zhenhuan.prod.env
```

文件内容如下。`DATABASE_URL` 中的数据库密码必须与 `POSTGRES_PASSWORD` 相同；如果密码包含 `@`、`:`、`/`、`?`、`#` 或 `%`，必须先进行 URL 编码。`APP_ORIGIN` 和 `NEXT_PUBLIC_API_URL` 必须使用同一个公网 HTTPS 地址，且不带末尾斜杠。

```dotenv
POSTGRES_DB=zhenhuan
POSTGRES_USER=zhenhuan
POSTGRES_PASSWORD=replace-with-a-strong-database-password
DATABASE_URL=postgresql://zhenhuan:replace-with-a-strong-database-password@postgres:5432/zhenhuan?schema=public

APP_ORIGIN=https://game.example.com
NEXT_PUBLIC_API_URL=https://game.example.com
APP_HOST=game.example.com

BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-strong-bootstrap-password
BOOTSTRAP_ADMIN_DISPLAY_NAME=超级管理员
SUPER_ADMIN_USERNAMES=admin

TLS_CERT_PATH=/etc/letsencrypt/live/game.example.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/game.example.com/privkey.pem
```

`APP_HOST` 只填写证书对应的域名，不带协议、端口、路径或尾斜杠。`migrate` 服务会在首次启动和每次需要重新创建服务时执行 Prisma migration 与幂等 seed。首次超管仅在提供 `BOOTSTRAP_ADMIN_*` 变量时创建；完成部署后，请通过 H5 超管后台创建其他账号。

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
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml ps --all
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml logs --tail=100 migrate api web nginx
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml exec -T api wget -qO- http://127.0.0.1:4000/health
curl -I https://game.example.com/
curl -s -o /dev/null -w '%{http_code}\n' https://game.example.com/api/auth/me
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

重启 API，或在证书更新后只重建 Nginx：

```bash
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml restart api
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml up -d --force-recreate --no-deps nginx
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
docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml exec -T api wget -qO- http://127.0.0.1:4000/health
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

新克隆的工作区先执行 `npm ci` 安装宿主机检查工具；这不会启动 Web 或 API。运行系统仍只使用 Docker Compose。

```bash
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
PLAYWRIGHT_EXTERNAL_STACK=1 npm run test:e2e
```

端到端测试固定复用 Docker Compose 在 `3000` 端口运行的 Web；先确认 `docker compose ps` 中 Web 与 API 正常，不要让 Playwright 另起宿主机服务或改用其他端口。

PostgreSQL 集成测试必须使用独立数据库，数据库名以 `_test` 结尾；如果同时设置 `DATABASE_URL`，测试数据库不得解析为同一主机、端口和数据库名。测试会创建隔离 schema，不能把开发或生产库配置为 `TEST_DATABASE_URL`。

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@localhost:55432/zhenhuan_test?schema=public' \
npm run test:integration
```

真实 Cookie/API/PostgreSQL Playwright 门禁额外要求 `TASK7_REAL_STACK=1`、显式测试账号前缀/密码、`*_test` 数据库、`task7_real_*` 临时 schema，以及 `NEXT_PUBLIC_API_URL=http://localhost:4000`。详细保护条件见 `tests/e2e/task7-real-stack.spec.ts`。

已知边界见 [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md)，迁移说明见 [MIGRATION_NOTES_V2.md](./MIGRATION_NOTES_V2.md)，本次最小实时检查清单见 [2026-07-28-realtime-room-sync.md](./docs/superpowers/plans/2026-07-28-realtime-room-sync.md)。
