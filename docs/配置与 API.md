# 配置与 API

日常使用与部署入口见 [README](../README.md)。

## 环境变量

以下变量由 Node.js 进程读取；手动运行时需在启动前设置。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ADMIN_PORT` | `2376` | 管理页面端口 |
| `API_PORT` | `2377` | Kikoeta 只读 API 端口 |
| `TRANSL_PORT` | `2378` | Transl 上传端口 |
| `DATA_DIR` | 项目下的 `data` | 数据与临时 ZIP 存放目录；Docker 默认为 `/data`。Windows 单文件版始终使用 EXE 同级的 `data`，不读取此变量 |
| `ADMIN_USER` | `admin` | 初始管理员账号；已有保存的账号时以保存值为准 |
| `COOKIE_SECURE` | 未启用 | 通过 HTTPS 访问管理页时设为 `true` |

Compose 已提供 `ADMIN_USER` 和 `COOKIE_SECURE` 的环境变量替换。修改其他变量需调整 Compose 的 `environment`；变更容器监听端口时，也需同步调整 `ports` 映射。

## 反向代理与认证

- 管理页位于 `/login`、`/library`、`/settings`，登录会话保存在进程内，重启后失效。
- `2377` 的兼容 API 无身份验证，当前 Kikoeta 客户端没有认证头配置。需要限制读取范围时，在网络或反向代理层控制访问。
- 若用路径前缀代理只读 API，应在转发时去掉前缀，让服务收到 `/api/lyrics-library/v1/...`。
- 管理员密码和 Transl 上传密码以加盐哈希保存。Transl 密钥同时保存原文以供管理页查看，应限制 `DATA_DIR` 的访问。

## 存储与限制

歌词内容、作品和 AI 标记存放在 `DATA_DIR/library.sqlite`，新增歌词不会按作品写入独立文件目录。SQLite 使用 WAL，运行时可能存在 `library.sqlite-wal` 和 `library.sqlite-shm`；停止服务后再备份整个数据目录。

| 项目 | 限制 |
| --- | --- |
| 作品号 | `RJ`、`VJ`、`BJ` 加数字，输入不区分大小写 |
| 歌词扩展名 | `.lrc`、`.txt`、`.srt`、`.vtt`、`.ass`、`.ssa` |
| 单文件 | 非空，最大 8 MiB |
| 单作品 | 最多 256 个文件，合计 32 MiB |
| 单次 ZIP 上传 | 最大 512 MiB |
| ZIP 累计解压内容 | 最大 2 GiB |
| ZIP 累计条目 | 最多 100,000 |
| ZIP 嵌套深度参数 | `MAX_DEPTH = 8`，见 `src/zip-import.js` |

ZIP 暂存于 `DATA_DIR`，处理结束后清理。管理页每次读取 50 部作品，支持作品号前缀和文件路径搜索；兼容 API 返回完整作品列表。

## Kikoeta 只读 API

默认端口：`2377`。

| 方法与路径 | 返回内容 |
| --- | --- |
| `GET /api/lyrics-library/v1/works` | 全部作品号、AI 标记、文件数 |
| `GET /api/lyrics-library/v1/works/{workId}/files` | 文件路径与元数据 |
| `GET /api/lyrics-library/v1/works/{workId}/lyrics` | 文件元数据与原始字节的 Base64 内容 |

文件路径为作品内以 `/` 分隔的安全相对路径。没有可用歌词的作品不会出现在列表中；查询不存在的作品返回 `404`，非 GET 请求返回 `405`。

## Kikoeta Transl 上传 API

默认端口：`2378`。

- `GET /api/v1/health`：健康检查，无需认证。
- `POST /api/v1/lyrics`：上传歌词，需要认证。

上传使用独立账号密码的 HTTP Basic，或 `Authorization: Bearer <12 位密钥>`。两种认证方式互斥；未配置有效凭据时，上传返回 `401`。

请求头设置 `Content-Type: application/json`，请求体示例：

```json
{
  "workId": "RJ123456",
  "files": [
    {
      "relativePath": "disc1/song.zh.lrc",
      "content": "WzAwOjAwLjAwXUhlbGxv"
    }
  ]
}
```

`content` 是歌词文件原始字节的 Base64 编码。上传会覆盖作品下相同路径的文件，并标记为 AI 歌词。文件格式和容量受上表限制。

## 开发验证

```sh
npm ci
npm test
```

接口实现位于 `src/server.js`，存储逻辑位于 `src/library.js`，ZIP 导入逻辑位于 `src/zip-import.js`。
