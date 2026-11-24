# 配置与 API

日常使用与部署入口见 [README](../README.md)。

## 端口与兼容

| 默认端口 | 用途 |
| --- | --- |
| `2377` | 主入口，提供管理页面、Kikoeta 只读 API 和 Kikoeta Transl 上传 |
| `2376` | 旧版管理地址，转发到主端口 |
| `2378` | 旧版 Transl 地址，转发到主端口 |

`2376` 和 `2378` 按 TCP 原样转发。三个端口上的接口和认证规则相同。请求 `http://lls.example.com:2376/login` 时，主服务收到的仍是 `Host: lls.example.com:2376`。转发保留请求方法、路径、请求体及 `Origin`、`Authorization`、`Cookie` 等原始请求头，也不会添加 `X-Forwarded-*`。

## 环境变量

手动启动时，可在启动前设置以下环境变量。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `API_PORT` | `2377` | 主端口，提供管理页面、只读 API 和 Transl 上传 |
| `ADMIN_PORT` | `2376` | 原管理端口，转发到 `API_PORT` |
| `TRANSL_PORT` | `2378` | 原 Transl 上传端口，转发到 `API_PORT` |
| `DATA_DIR` | 项目下的 `data` | 数据与临时 ZIP 存放目录。Docker 默认为 `/data`。Windows 单文件版固定使用 EXE 同级的 `data` |
| `ADMIN_USER` | `admin` | 初始管理员账号。已有保存的账号时以保存值为准 |
| `COOKIE_SECURE` | `false` | 通过 HTTPS 访问管理页时设为 `true`，为登录 Cookie 加上 `Secure` 属性 |

三个端口必须是 `1` 到 `65535` 之间互不重复的整数。Compose 默认发布三个端口，如果只需对外提供主入口，可以在 `ports` 中只保留 `2377:2377`。Compose 已提供 `ADMIN_USER` 和 `COOKIE_SECURE` 的环境变量替换。修改其他容器环境变量需调整 `environment`，修改容器监听端口时需同步更新相应的 `ports` 映射。

## 请求头

| 请求 | 请求头 |
| --- | --- |
| Kikoeta 只读 API `GET /api/lyrics-library/v1/works…` | Kikoeta 客户端发送 `Accept: application/json`，接口无需认证 |
| Transl 健康检查 `GET /api/v1/health` | 无需认证或自定义请求头 |
| Transl 上传 `POST /api/v1/lyrics` | `Content-Type: application/json`，以及 `Authorization: Bearer <12 位密钥>` 或 `Authorization: Basic <Base64(用户名:密码)>` |
| 管理登录 `POST /api/login` | `Content-Type: application/json`，请求体字段为 `user` 和 `password` |
| 管理 API（登录后） | `Cookie: lls_session=<会话令牌>`，非 GET 请求另带 `X-LLS-CSRF: <令牌>`。有 JSON 请求体时使用 `Content-Type: application/json`，ZIP 导入使用 `Content-Type: application/zip` |

## 网页管理与反向代理

- 管理页面位于 `/login`、`/library`、`/settings`。登录成功时，响应头 `Set-Cookie` 设置 `lls_session`，响应 JSON 返回 `csrf`。已登录时也可通过 `GET /api/session` 读取当前 CSRF 令牌。会话保存在进程内，重启后失效。
- 管理 API 收到 `Origin` 时，会要求其中的主机和端口与 `Host` 一致。反向代理应保留浏览器访问地址对应的 `Host`，包括非默认端口。使用 HTTPS 代理管理页时，可启用 `COOKIE_SECURE=true`。
- 如果外部用户只需要读取歌词库，可在反向代理层仅放行 `/api/lyrics-library/v1/`。给只读 API 添加外部路径前缀时，转发前去掉该前缀。

公网反向代理应使用 HTTPS，并保留上传请求的 `Authorization` 头。

## Kikoeta 只读 API

| 方法与路径 | 返回内容 |
| --- | --- |
| `GET /api/lyrics-library/v1/works` | 作品号、AI 标记、文件数，可分页 |
| `GET /api/lyrics-library/v1/works/{workId}/files` | 文件路径与元数据 |
| `GET /api/lyrics-library/v1/works/{workId}/lyrics` | 文件元数据与原始字节的 Base64 内容 |

省略 `limit` 时返回完整作品列表。分页时传入 `limit`（`1` 到 `1000`），把上一页返回的 `nextCursor` 作为下一页的 `after`。`nextCursor` 为 `null` 时已到末页。

```sh
curl -H 'Accept: application/json' 'http://127.0.0.1:2377/api/lyrics-library/v1/works?limit=50'
```

文件路径为作品内以 `/` 分隔的安全相对路径。列表只包含有歌词的作品。查询不存在的作品返回 `404`，非 GET 请求返回 `405`。

## Kikoeta Transl 上传 API

| 方法与路径 | 返回内容 |
| --- | --- |
| `GET /api/v1/health` | `{"ok":true,"name":"kikoeta-lls-transl"}` |
| `POST /api/v1/lyrics` | 成功时返回 `workId` 和本次保存的文件数 `saved` |

上传凭据在管理页「设置 → Kikoeta Transl 上传」里配置。Basic 使用独立的上传账号密码，Bearer 使用 12 位字母数字密钥。两种方式只能启用一种。凭据缺失或无效时返回 `401`。

先将上传密钥设为 shell 变量 `LLS_UPLOAD_KEY`，再执行下方命令。`content` 为歌词文件原始字节的 Base64 编码。相同作品下已有同路径文件时会被覆盖，上传的文件会标记为 AI 歌词。

```sh
curl -X POST 'http://127.0.0.1:2377/api/v1/lyrics' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $LLS_UPLOAD_KEY" \
  -d '{"workId":"RJ123456","files":[{"relativePath":"disc1/song.zh.lrc","content":"WzAwOjAwLjAwXUhlbGxv"}]}'
```

使用 Basic 认证时，将示例中的 `Authorization` 参数换成 `--user '<上传用户名>'`，由 `curl` 提示输入上传密码。

## 存储与限制

歌词正文、作品索引和 AI 标记存放在 `DATA_DIR/library.sqlite`。SQLite 使用 WAL，运行时可能存在 `library.sqlite-wal` 和 `library.sqlite-shm`。备份前先停止服务，再复制整个数据目录。

管理员密码和 Transl 上传密码以加盐哈希保存。Transl 密钥保存原文供管理页查看，应限制数据目录的访问权限。

| 项目 | 限制 |
| --- | --- |
| 作品号 | `RJ`、`VJ`、`BJ` 加数字，输入不区分大小写 |
| 歌词扩展名 | `.lrc`、`.txt`、`.srt`、`.vtt`、`.ass`、`.ssa` |
| 单文件 | 非空，最大 8 MiB |
| 单作品 | 最多 256 个文件，合计 32 MiB |
| 单次 ZIP 上传 | 最大 512 MiB |
| ZIP 累计解压内容 | 最大 2 GiB |
| ZIP 累计条目 | 最多 100,000 |
| ZIP 嵌套深度 | 最多 8 层，最外层 ZIP 按第 0 层计算 |

ZIP 暂存于 `DATA_DIR`，处理结束后清理。管理页每次读取 50 部作品，支持作品号前缀和文件路径搜索。

## 开发验证

```sh
npm ci
npm test
```

接口实现位于 `src/server.js`，存储逻辑位于 `src/library.js`，ZIP 导入逻辑位于 `src/zip-import.js`。
