# Kikoeta-LLS

Kikoeta 独立远程歌词库服务端。管理页面使用 **2376** 端口；供 Kikoeta 导入的只读 API 使用 **2377** 端口；Kikoeta Transl 同步上传使用 **2378** 端口。

## Windows 本机运行

安装 Node.js 24.15 或更新版本后，双击 `start.bat`。首次启动缺少依赖时会运行 `npm ci`，然后直接在 Windows 上运行 Node 服务，无需 Docker。首次使用 `admin / kikoeta-lrc` 登录后，只需输入一次新密码，不必再输入当前密码或确认密码；完成前不能管理歌词。新密码至少 6 位，纯数字或纯字母均可。账号和新密码保存在 `data/admin-credentials.json`，作品索引、AI 标记和歌词内容保存在 `data/library.sqlite`。命令窗口需要保持开启，按 Ctrl+C 可停止服务。

## Linux Docker 部署

Dockerfile 和 Compose 配置供 Linux 服务器部署使用：

```sh
docker compose up -d --build
```

打开 `http://服务器地址:2376/login` 登录；歌词库和设置页面分别位于 `/library` 和 `/settings`。在 Kikoeta 的“导入 → 远程库”填写 `http://服务器地址:2377`。首次用 `admin / kikoeta-lrc` 登录并修改密码。数据库、管理账号和翻译上传凭据都保存在 Docker 的 `lls_data` 命名卷中，容器内分别为 `/data/library.sqlite`、`/data/admin-credentials.json`、`/data/transl-credentials.json`。重新创建容器后数据仍会保留；删除该卷会丢失歌词和登录信息。

可在管理页上传 `.lrc`、`.txt`、`.srt`、`.vtt`、`.ass`、`.ssa` 文件，按需填写子目录并标记 AI 歌词；页面也可修改 AI 标记或删除文件。一次可选择多个文件，单文件最大 8 MiB。没有可用歌词文件的作品不会出现在远程索引中。上传相同路径会替换该文件。
“批量导入 ZIP”可一次选择多个压缩包。服务端按包内 RJ/VJ/BJ 目录或压缩包文件名识别作品，也支持作品 ZIP 套在总 ZIP 中；同名文件处理默认跟随设置页偏好，也可在导入时选择跳过或覆盖。导入前可统一设置 AI 标记。单个上传包最大 512 MiB，解压内容累计最多 2 GiB；条目数及嵌套深度另有限制，超限会拒绝该包。ZIP 会临时存入 `DATA_DIR`，导入结束后自动清理。
管理页每次读取 50 部作品，可按作品号前缀或文件路径搜索。左侧“设置”可修改登录账号和密码，也可保存当前浏览器的浅色／深色主题、ZIP 同名文件处理方式和 AI 标记默认值。修改账号或密码后，其他设备需要重新登录。2377 端口的公开接口仍按 Kikoeta 协议返回完整作品列表。

如需让 Kikoeta Transl 将翻译产物同步到歌词库，在 LLS 管理页“设置 → Kikoeta Transl 上传”中选择一种验证方式：配置独立的上传账号密码，或生成／手动设置 12 位数字字母密钥。保存一种方式会停用另一种；未配置时 2378 端口拒绝上传。然后在 Kikoeta Transl 的“输出”页开启同步选项，填入同一凭据。地址留空表示 Transl 与 LLS 在同一台机器，使用 `http://127.0.0.1:2378`；跨机器时填写可到达的 `http(s)://服务器地址:2378`。该配置仅作用于来自 Kikoeta 且带有效作品号的成功任务，上传的歌词会标记为 AI。密钥会保存在服务端授权配置中，重新打开设置页时可再次显示和复制；请限制对 `DATA_DIR` 的访问。旧版本只保存密钥摘要，无法恢复已经生成的密钥，升级后需重新设置一次，此后可以随时查看。

## 数据存储

SQLite 数据库位于 `DATA_DIR/library.sqlite`，含作品、歌词文件、歌词原始字节和 AI 标记；不再按作品创建新的歌词文件。SQLite 使用 WAL，运行期间可能同时存在 `library.sqlite-wal`、`library.sqlite-shm`。备份前请停止服务，再复制整个数据目录。

## 手动运行 Node.js

需要 Node.js 24.15 或更新版本。首次运行先安装依赖：

```sh
npm ci
node src/server.js
```

可用环境变量：`HOST`（默认 `0.0.0.0`）、`ADMIN_PORT`（默认 `2376`）、`API_PORT`（默认 `2377`）、`TRANSL_PORT`（默认 `2378`）、`DATA_DIR`（默认项目下 `data`）、`ADMIN_USER`（首次登录账号，设置页修改后以保存的账号为准）、`COOKIE_SECURE`（通过 HTTPS 访问管理页时设为 `true`）。`npm test` 运行接口测试。管理账号与加盐哈希密码保存在 `DATA_DIR/admin-credentials.json`；翻译上传账号密码以哈希保存，密钥原文保存在 `DATA_DIR/transl-credentials.json`，以便在管理页重新查看。请限制对 `DATA_DIR` 的访问。

如需公网访问，请用 HTTPS 反向代理保护管理页，并限制可访问的设备。2377 端口的兼容 API 按协议无身份验证；Kikoeta 当前客户端也没有认证头配置。管理页的登录会话仅存在进程内，服务重启后需要重新登录。把反向代理的路径前缀转发到 2377 端口时，需去除前缀，使服务端收到 `/api/lyrics-library/v1/...` 路径。

## API v1

只读接口：

| 方法与路径 | 内容 |
| --- | --- |
| `GET /api/lyrics-library/v1/works` | 全部作品号、AI 标记、文件数 |
| `GET /api/lyrics-library/v1/works/{workId}/files` | 文件路径和元数据 |
| `GET /api/lyrics-library/v1/works/{workId}/lyrics` | 元数据与原始文件字节的 Base64 |

作品号支持 `RJ`、`VJ`、`BJ` 加数字，不区分输入大小写。API 中的文件路径始终是作品下使用 `/` 分隔的安全相对路径，实际内容存储在 SQLite 中。每部作品最多 256 个文件、总计 32 MiB，单文件超过 8 MiB 或为空时不能导入。

2378 端口提供 `GET /api/v1/health` 和 `POST /api/v1/lyrics`。上传请求为 JSON：`{"workId":"RJ123","files":[{"relativePath":"disc/song.zh.lrc","content":"Base64 字符串"}]}`；使用独立账号密码的 HTTP Basic 或 `Authorization: Bearer <12 位密钥>` 验证。写入会覆盖同一作品下同一路径的文件。

## 许可

AGPL-3.0，见 [LICENSE](LICENSE)。
