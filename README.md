# 校园服务台 · 云托管后端

微信云托管服务，给小程序提供「服务条目 + 公告」的下发，以及一个网页管理后台。

## 它做什么

| 接口 | 谁用 | 说明 |
|---|---|---|
| `GET /api/config` | 小程序 | 下发全部服务条目、公告、数据版本号 |
| `GET /api/health` | 运维 | 存活与数据库连通性 |
| `POST /api/admin/login` | 后台网页 | 账号密码换 token（12 小时） |
| `GET /api/admin/overview` | 后台网页 | 服务列表 + 公告 |
| `POST /api/admin/service` | 后台网页 | 新增 / 修改一条服务 |
| `DELETE /api/admin/service/:id` | 后台网页 | 删除一条服务 |
| `POST /api/admin/notice` | 后台网页 | 保存首页公告 |
| `GET /api/admin/export` | 后台网页 | 导出成小程序本地兜底用的 `services.js` |

管理后台页面：`/admin`

## 环境变量

云托管会自动注入 `MYSQL_ADDRESS`、`MYSQL_USERNAME`、`MYSQL_PASSWORD`，不用管。

需要自己加的两个（在「服务设置 → 环境变量」里）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_USER` | `admin` | 后台账号 |
| `ADMIN_PASS` | `campus2026` | **务必改掉** |
| `ADMIN_SECRET` | 由密码派生 | 可选，用于签发 token |

## 第一次启动

会自动建库 `campus`、建表 `services` / `settings`，并把 `seed.json` 里的 18 条服务灌进去。
表里已有数据不会重复灌，所以重启安全。

## 数据结构

一条服务对应 `services` 表的一行，字段与小程序 `data/services.js` 的 camelCase 一一对应（数据库用 snake_case）。

`settings` 表就两个 key：`version`（每次写入自增，小程序据此判断要不要更新）和 `notice`（首页公告）。

## 升级

直接改代码重新发布即可，库里的数据不受影响。
