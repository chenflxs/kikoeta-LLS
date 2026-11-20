# 手动发布 Docker 镜像

工作流 `.github/workflows/docker-publish.yml` 仅在手动运行时构建并上传镜像到 [chenflxs/kikoeta-lls](https://hub.docker.com/r/chenflxs/kikoeta-lls)，提交代码或创建 Release 不会自动发布。它复用根目录的 Dockerfile，同时发布 `linux/amd64` 和 `linux/arm64` 镜像。

## 首次配置

1. 在 Docker Hub 创建 `chenflxs/kikoeta-lls` 镜像仓库。
2. 创建对目标仓库有写入权限的 Docker Hub Access Token。
3. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions → New repository secret** 中添加：

   | Secret | 内容 |
   | --- | --- |
   | `DOCKERHUB_USERNAME` | Docker Hub 登录用户名 |
   | `DOCKERHUB_TOKEN` | 上述 Access Token |

组织镜像的命名空间可以与登录用户名不同，但登录账号必须拥有目标仓库的推送权限。不要把 Token 写入源码。

## 运行

将工作流提交到 GitHub 默认分支后，打开 **Actions → Publish Docker image → Run workflow**：

- 选择要构建的分支。
- `tag`：默认 `latest`，也可以填写 `0.1.0` 等版本标签。

点击 **Run workflow**。成功后可拉取 `chenflxs/kikoeta-lls:latest`（或实际填写的标签）。每次只发布填写的一个标签；发布版本标签不会同时更新 `latest`。重复使用同一标签会覆盖该标签指向的镜像。

## 使用已发布镜像

将 `compose.yaml` 中的 `build: .` 替换为 `image: chenflxs/kikoeta-lls:latest`，保留其他配置，然后执行：

```sh
docker compose pull
docker compose up -d
```

服务端口、首次登录与数据备份方式见 [README](../README.md)。

工作流的多架构构建方式参考 [Docker 官方文档](https://docs.docker.com/build/ci/github-actions/multi-platform/)。
