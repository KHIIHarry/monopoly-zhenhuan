# 局域网 HTTP 开发部署设计

## 目标

为同一可信 Wi-Fi 中的实体桌游设备提供一条显式、可重复的局域网 HTTP 启动路径。主持电脑运行一个命令后，手机和平板通过电脑的私有 IPv4 地址访问 H5，REST API 与 Socket.IO 使用同一台电脑的局域网地址。

## 非目标

- 不允许将 HTTP 局域网模式用于生产环境。
- 不放宽为任意来源或通配 CORS。
- 不自动修改系统防火墙、路由器端口映射或公网配置。
- 不改变 PostgreSQL 只绑定本机的默认设置。

## 启动接口

新增 `npm run dev:lan`。

启动脚本从可用网卡中选择 RFC1918 私有 IPv4，优先使用常见 Wi-Fi 网卡。用户可通过 `LAN_HOST=192.168.x.x npm run dev:lan` 显式覆盖。脚本拒绝回环地址、公网地址、IPv6、主机名和带端口的输入。

启动脚本向现有开发命令注入：

- `LAN_HTTP_ORIGIN=http://<LAN_HOST>:3000`
- `NEXT_PUBLIC_API_URL=http://<LAN_HOST>:4000`
- `NEXT_ALLOWED_DEV_ORIGINS=<LAN_HOST>`

启动成功时输出玩家访问地址与 API 地址。无法唯一确定私有 IPv4 时，脚本以非零状态退出，并提示使用 `LAN_HOST`。

## API 安全边界

`LAN_HTTP_ORIGIN` 是局域网模式唯一开关，只在非生产环境读取。它必须是无用户名、密码、路径、查询或片段的精确 HTTP origin，主机必须为 RFC1918 IPv4，端口必须为 `3000`。

开发环境的允许来源为：

- 现有 localhost/127.0.0.1/IPv6 loopback HTTP 来源；
- 有效 `LAN_HTTP_ORIGIN` 的精确值。

相邻 IP、其他端口和其他私网来源继续返回 `403 ORIGIN_NOT_ALLOWED`。生产环境继续只接受精确 HTTPS `APP_ORIGIN`，并拒绝设置 `LAN_HTTP_ORIGIN`，避免误将局域网模式带入生产。

## Cookie 与会话

默认开发模式和生产模式继续发送 `Secure` 会话 Cookie。只有存在有效 `LAN_HTTP_ORIGIN` 的非生产进程，登录与清理会话 Cookie 才省略 `Secure`，同时保留 `HttpOnly`、`SameSite=Lax`、`Path=/` 和原有效期。

由于页面与 API 使用相同私有 IP、不同端口，浏览器会在凭据请求和 Socket.IO 握手中携带该 Cookie。局域网 HTTP 流量不加密，因此 README 必须明确仅限可信 Wi-Fi，且禁止公网端口映射。

## 代码边界

- `scripts/lan-http-config.mjs`：私有 IPv4 校验、网卡候选选择与环境值生成，可独立单测。
- `scripts/start-lan.mjs`：调用配置模块并启动现有 `npm run dev`，只负责进程编排与提示。
- `apps/api/src/app.ts`：验证局域网 origin，决定 CORS/Socket.IO 来源与 Cookie 安全标记。
- `package.json`：暴露 `dev:lan` 命令。
- `.env.example` 与 `README.md`：记录可选变量、启动步骤、防火墙与安全限制。

## 测试与验收

自动化测试必须证明：

1. 自动选择私有 IPv4，且 `LAN_HOST` 可覆盖。
2. 公网、回环、主机名和畸形地址被拒绝。
3. 精确局域网来源的 REST 预检被允许，相邻来源被拒绝。
4. 局域网登录 Cookie 不含 `Secure`，仍含 `HttpOnly` 与 `SameSite=Lax`。
5. 普通开发与生产 Cookie 继续包含 `Secure`。
6. 生产环境拒绝 `LAN_HTTP_ORIGIN`，并继续要求精确 HTTPS `APP_ORIGIN`。
7. `npm run lint`、`npm run typecheck`、`npm run test` 与 `npm run build` 全部通过。
8. 使用 `npm run dev:lan` 后，局域网地址的 H5 与 `/health` 可访问，浏览器能完成登录请求并建立 Socket.IO 连接。

## 运维说明

电脑与玩家设备必须连接同一 Wi-Fi。macOS 首次弹出 Node.js 入站连接提示时需要允许。电脑 IP 变化后重启 `npm run dev:lan`；需要固定地址时应在路由器 DHCP 中为主持电脑保留地址。不得将 `3000`、`4000` 或 `5432` 映射到公网。
