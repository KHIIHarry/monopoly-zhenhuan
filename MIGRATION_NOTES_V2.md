# V2.1 旧身份数据迁移与清理说明

## 迁移原则

旧版设备令牌无法安全、可靠地映射到真实账号，因此不把任何 `deviceTokenHash` 转换成登录 Session，也不允许旧设备在升级后继续获得房间写权限。账本、审计、交易和地产数据必须保留，不能通过删除旧房间规避迁移。

## 自动迁移

`202607260006_account_room_v2` 创建账号、Session、房间成员关联、交换和结算基础表；`202607270007_dual_role_capabilities` 再把成员模型升级为 V2.1。两者按顺序执行以下处理：

1. 创建账号、服务端 Session、角色交换、结算和安全日志表。
2. 将旧 `RoomMember` 表作为 V2 `RoomMembership` 继续使用，保留所有被账本和审计引用的主键；删除互斥成员 `role`，改为 nullable `characterId` 与独立 `isBank`。
3. 为每条旧成员记录创建唯一的禁用占位账号，昵称取旧 `displayName`，用户名使用不可登录的 `legacy-<memberId>`。
4. 旧 `PLAYER` 成员从关联 Player 复制 `characterId`，旧 `BANK` 成员迁移为 `isBank=true`。旧数据不存在人物兼任银行关系，因此迁移不会合并不同成员或猜测兼任关系。
5. 删除旧 `deviceTokenHash`、在线状态和银行设备授权字段，把旧成员状态标记为 `LEFT`，`activeSessionId` 置空；旧令牌升级后立即失效。
6. 为旧房间关联一个禁用的迁移系统账号；旧 `LOBBY`、`PLAYING`、`ENDED` 房间统一标记为 `FINISHED`，避免新版写接口继续修改没有真实账号归属的历史局。
7. 保留旧 Player、地产、账本、交易、审计和骰子记录，仅作为历史数据；不会自动生成缺少可靠结束时点的 V2 结算快照。
8. 增加账号房间唯一约束、人物席位唯一约束和 `WHERE isBank=true AND status='ACTIVE'` 的银行部分唯一索引。
9. 对 V2 结算表增加 UPDATE、DELETE、TRUNCATE 拒绝触发器，确保结算快照不可变；测试库只能在显式绑定当前事务的清理能力下重置。

## 实时状态版本迁移

`202607280012_room_state_version` 只向 `Room` 增加非空整数列 `stateVersion`，默认值为 `0`。迁移不会重建房间、修改成员/人物/银行能力、释放席位或改写资金、地产、账本和结算数据。

既有房间从版本 `0` 开始；升级后下一次实际提交的核心房间事务在同一事务中递增版本。系统不会根据历史更新时间推测或伪造旧版本。失败事务和幂等重放不递增。

## V2.1 兼任语义

- 新成员先加入房间，再在同一行上选择至多一个人物及可选银行能力。
- 人物后选择银行只把 `isBank` 设为 `true`；不会新增 Player、资金、地产或账本。
- 银行后选择人物只在首次取得人物时创建一个 Player，并发放一次初始资金和初始宫殿。
- 两种能力共用一个 `activeSessionId`。迁移不会把旧玩家设备与旧银行设备拼成一个兼任账号。

## 上线步骤

```bash
npm run db:generate
npm run db:migrate
BOOTSTRAP_ADMIN_USERNAME=admin \
BOOTSTRAP_ADMIN_PASSWORD='<强密码>' \
BOOTSTRAP_ADMIN_DISPLAY_NAME='超级管理员' \
npm run db:seed
```

首次 V2 登录必须使用 bootstrap 超管创建的新账号。旧房间只能在历史列表查看；需要继续实体对局时，由拥有 `canCreateRoom` 权限的账号新建房间并由参与者重新选择席位。

## 回滚边界

迁移前必须创建 PostgreSQL 备份。Schema 回滚不能恢复已经清空的明文设备控制关系，也不应重新启用旧设备令牌；如需回退应用版本，应恢复迁移前整库备份，而不是单独回滚表结构。
