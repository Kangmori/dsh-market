# Fork 自动化：把 dsh.market 的 plugins.json 变成 DSH 官方索引格式

这套文件用于 fork [2BingLing/dsh-market](https://github.com/2BingLing/dsh-market) 后，在 GitHub Actions 里每天自动：

1. 拉取上游 `data/plugins.json`（schemaVersion 2，每天北京时间 03:00 采集、06:00 兜底）；
2. 解析每个插件对应的 npm 包 / Git 仓库，补上 format 1 必需的版本与发布时间；
3. 用 DSH 官方 `parseMarketIndex` 校验；
4. 把 `index.json`、`conversion-report.json`、`meta.json` 强制推送到本仓库的 **`market` 分支**（不碰 `master`，不和上游每日提交打架）。

最终给 DSH 用的地址是：

```
https://raw.githubusercontent.com/<你的账号>/dsh-market/market/index.json
```

`raw.githubusercontent.com` 直接返回 200，不重定向——DSH 抓取索引时 `redirect: 'error'`，所以不能用 `github.com/.../raw/...`（那个会 302）。

---

## 目录

复制到 fork 根目录（保持相对路径）：

```
.github/workflows/build-dsh-index.yml   # 每日构建
tools/convert.js                        # 转换器（无第三方依赖）
tools/validate.js                       # 校验器（可选调用官方 parser）
reference/index.json                    # 参考索引快照（npm 身份 + 分类训练集）
```

其余文件（`plugins.json`、`index.json`、`conversion-report.json`、`REPORT.md`）不需要放进 fork。

## 一次性配置

### 1. 创建 fork

```powershell
gh repo fork 2BingLing/dsh-market --clone=false --remote=false
```

或在网页上点 **Fork**。

### 2. 放入自动化文件

把本目录（`fork/`）下的 `.github/`、`tools/`、`reference/` 复制到 fork 根目录并提交：

```powershell
git clone https://github.com/<你的账号>/dsh-market.git
cd dsh-market
# 把 fork/ 里的三个目录复制进来
git add .github/workflows/build-dsh-index.yml tools reference
git commit -m "ci: 自动把 plugins.json 转换为 DSH format 1 索引"
git push origin master
```

### 3. 启用 Actions，并放开写权限

fork 默认不会自动跑 workflow：打开 fork 的 **Actions** 标签页，点 **"I understand my workflows, go ahead and enable them"**。

然后到 **Settings → Actions → General → Workflow permissions**，选 **Read and write permissions** 并保存。默认的只读 token 无法向 `market` 分支 push；这一项只需设置一次。

推荐再加一个 **classic PAT**（只需要 `public_repo`）放到 **Settings → Secrets and variables → Actions → New repository secret**，名字 `GH_PAT`。转换器的 Git 兜底要读约 3,300 个公开仓库的 `package.json`；实测内置 `github.token` 可以读跨仓库数据（本次构建 Git 来源 2,785 条），所以 PAT 不是必需，只在 `bySourceType.git` 异常为 0 时再补。

### 4. 关掉上游自带的工作流（重要）

fork 会继承上游的 6 个 workflow，它们依赖 `GH_PAT`、`DEEPSEEK_API_KEY` 等 secrets，在 fork 里每天会失败甚至尝试提交数据。建议在 fork 里禁用：

```powershell
$wfs = @('collect-and-deploy.yml','collect-backup.yml','decay-scan.yml','deploy-web.yml','issue-auto-reply.yml','issue-reply.yml')
foreach ($w in $wfs) { gh workflow disable $w -R <你的账号>/dsh-market }
```

只保留 `build-dsh-index.yml`。禁用是仓库服务端状态，`Sync fork` 不会把它重新打开。

### 5. 手动跑一次

```powershell
gh workflow run build-dsh-index.yml -R <你的账号>/dsh-market
gh run watch -R <你的账号>/dsh-market
```

首次是冷缓存：约 2 万次 npm 查询 + 约 3,300 个 GitHub 仓库，通常 5–10 分钟。之后每天走缓存，通常 1–2 分钟。

### 6. 验证产物

```powershell
# 应返回 200，Content-Type 是 application/json 或 text/plain，均可用
curl.exe -I https://raw.githubusercontent.com/<你的账号>/dsh-market/market/index.json

# 看条数与来源
curl.exe -s https://raw.githubusercontent.com/<你的账号>/dsh-market/market/meta.json
```

`meta.json` 形如：

```json
{
  "upstreamGeneratedAt": "2026-10-21T23:24:49.519Z",
  "generatedAt": "2026-10-22T10:53:13.181Z",
  "format": 1,
  "plugins": 8012,
  "sourceTypes": { "npm": 5227, "git": 2785 },
  "indexUrl": "https://raw.githubusercontent.com/<你的账号>/dsh-market/market/index.json"
}
```

### 7. 加到 DSH

在 DSH 的插件市场设置里把上面的 `index.json` 地址加入索引源（配置项 `indexes`）。DSH 缓存 10 分钟，刷新即可看到。

---

## 为什么这样设计

| 选择 | 原因 |
|---|---|
| 从 raw 拉上游，而不是 clone 上游 | 上游每天往 git 里提交 48 MiB 的 `plugins.json`，历史已有 140+ MiB；clone 会让 CI 又慢又重 |
| checkout 只取 `tools` + `reference`，并开 `filter: blob:none` | 工作区只有几十 KB；否则 `actions/checkout` 每天要拉 80+ MiB 数据 |
| 产物推 `market` 分支，而不是 `master` | 不干扰上游的每日数据提交，`Sync fork` 不会冲突；也避免每天往 master 堆 6 MiB 产物 |
| 用 `raw.githubusercontent.com` 而不是 Pages | 不需要在 fork 里启用 Pages；raw 直接 200，DSH 不会因重定向失败 |
| 固定 `@deepseek-ai/dsh-plugin-market-index@0.2.1-rc.2` | 校验规则随 DSH 版本变化；固定版本让失败可见，升级时显式改 `MARKET_INDEX_PKG` |
| 输出 < 1000 条就中止发布 | 防止上游 schema 变更/半截下载把线上索引变成空文件 |
| 参考索引拉取失败时回退仓库快照 | `awesome-dsh-plugin.com/index.json` 与 `index.json` 当前字节一致；快照保证断网也能构建 |

## 上游同步

日常不需要同步：数据每天从 raw 拉，代码只依赖 `plugins.json` 的 schemaVersion 2。

只有两种情况要 `Sync fork`：

- 转换器要跟进上游新增字段（例如 `install` 结构变化）；
- 想合并上游对 `scripts/`、`web/` 的改动。

同步只影响 `master`；`market` 是独立分支，不会被覆盖。本套文件都是新增文件，合并一般无冲突。

## 注意事项

- **品牌**：上游是 MIT（代码与文档），但 `dsh.market` 名称、logo、域名属于品牌资产，不随 MIT 授权。fork 后请用中性名字（本方案产物名 `dsh-market-index`），不要使用上游品牌做对外宣传。
- **数据归属**：索引内容来自上游目录与 npm/GitHub 公开数据；`meta.json` 里保留了 `upstream` 字段，便于溯源。
- **Actions 配额**：公开仓库的 standard runner 免费；每天 1 次、5–10 分钟，远低于限额。
- **速率限制**：npm registry 无硬配额（脚本有 3 次退避重试）；GitHub GraphQL 用 `github.token`，约 67 次批量查询/天，远低于 1,000 点/小时。
- **计划任务**：GitHub 的 schedule 在 fork 里默认关闭，需要手动启用；仓库连续 60 天无活动会被暂停，而每天推送 `market` 分支本身就算活动。
- **失败排查**：workflow 失败时会保留 `conversion-debug` artifact（含 `conversion-report.json` 和上游 `plugins.json`）。常见失败是上游把 `schemaVersion` 升到 3，此时拉取步骤会直接报错并中止。
