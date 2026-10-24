# DSH 插件索引（format 1）

由 [2BingLing/dsh-market](https://github.com/2BingLing/dsh-market) 每日产出的 `data/plugins.json` 自动转换而来。

> **本分支是构建产物，请勿手改。** 每次构建都会用新的 orphan commit 强制覆盖；要改内容请改 [master 分支](https://github.com/Kangmori/dsh-market) 的 `tools/convert.js` 或 `.github/workflows/build-dsh-index.yml`。

## 在 DSH 中使用

把这个地址加到 DSH 的插件市场索引源（Settings → Plugins / Discover → 索引源，配置项 `plugin-market.indexes`）：

```
https://raw.githubusercontent.com/Kangmori/dsh-market/market/index.json
```

`raw.githubusercontent.com` 直接返回 200，不重定向（DSH 抓取时 `redirect: 'error'`，所以不能用 `github.com/.../raw/...`）。

中国大陆网络如果访问 raw 不稳定，可试 jsDelivr 镜像（缓存时间更长）：

```
https://cdn.jsdelivr.net/gh/Kangmori/dsh-market@market/index.json
```

自检：

```bash
curl -I https://raw.githubusercontent.com/Kangmori/dsh-market/market/index.json          # 200，且没有 Location（不能是 302）
curl -s  https://raw.githubusercontent.com/Kangmori/dsh-market/market/meta.json   # 看本次构建时间与条数
```

## 当前构建

| 项目 | 值 |
|---|---|
| 上游数据时间 | 2026-10-23 22:06:23 UTC |
| 本次构建 | 2026-10-24 04:50:22 UTC |
| 插件数 | **8,388** |
| 来源 | npm 5,454（65.0%） · git 2,934（35.0%） |
| 分类 | 24 个；`other` 1,088（13.0%） |
| 主要分类 | `ui` 1,628 · `other` 1,088 · `session` 712 · `tools` 706 · `model` 562 · `usage` 469 · `dev` 331 · `workflow` 305 |
| 文件大小 | 6.42 MiB |
| 校验 | DSH 官方 `parseMarketIndex` 通过（[构建日志](https://github.com/Kangmori/dsh-market/actions/runs/40063889780)） |

## 本分支文件

| 文件 | 用途 |
|---|---|
| `index.json` | format 1 索引，DSH 直接读取 |
| `meta.json` | 构建元数据：上游时间、条数、来源统计、索引地址 |
| `conversion-report.json` | 转换明细：各来源计数、丢弃原因、分类分布 |
| `README.md` | 本文件，构建时自动生成 |

## 数据是怎么来的

上游 `plugins.json` 是 GitHub 仓库目录（`schemaVersion 2`），**没有任何版本字段**；而 format 1 要求每条插件至少一个精确 SemVer、发布时间和 `npm`/`git` 来源。因此不能靠字段改名，构建分四步：

1. 用公开的 awesome-dsh-plugin 索引反查 npm 包名 / 版本 / `engines.dsh` / 分类；
2. 从 `install.commands`、README、homepage 提取候选包名，查 npm registry，并用包的 `repository` 字段核对同一个 GitHub 仓库；
3. 对显式声明 `github:<自身仓库>` 安装方式的插件，用 GitHub GraphQL 读默认分支 `package.json` 与 commit，生成固定 commit 的 `git` 来源；
4. 同名包去重、分类推断、声明 `stars`/`score` 排序键，最后用官方 parser 校验。

构建脚本在 master 分支：[workflow](https://github.com/Kangmori/dsh-market/blob/master/.github/workflows/build-dsh-index.yml)、[convert.js](https://github.com/Kangmori/dsh-market/blob/master/tools/convert.js)、[validate.js](https://github.com/Kangmori/dsh-market/blob/master/tools/validate.js)。

## 更新节奏

- 上游：北京时间 03:00 主采集、06:00 兜底（UTC 19:00 / 22:00）。
- 本索引：北京时间 **08:30** 自动构建（UTC 00:30），冷跑约 5 分钟，热跑 1–2 分钟。
- raw CDN 缓存 5 分钟；jsDelivr 缓存可能到 12 小时，急用请走 raw。

## 口径与限制

- **版本**：npm 来源取构建时刻的 latest；git 来源的版本取自仓库 `package.json`，commit 固定。
- **分类**：规则 + 标签统计的推断值，不确定归 `other`，不要当权威元数据。
- **收录范围**：只保留能证明来源的插件；无法解析 npm/git 的条目会被丢弃，原因见 `conversion-report.json`。
- **无签名**：索引内容来自第三方目录与公开 registry，是市场的声明，不构成安装背书；装什么以安装清单为准。

## 常见问题

**为什么条数比上游 13,840 少？**
format 1 要求每条插件有可安装的 npm/git 来源和版本。上游目录里有 5,239 条解析不出 npm 包、也没有自指仓库的 git 安装命令（其中约 55% 是 0 star 的抓取噪声），这些会被丢弃；明细见 `conversion-report.json`。

**版本为什么和我本地看到的不一样？**
npm 来源取构建时刻的 `dist-tags.latest`，每天会变；git 来源固定到构建时默认分支的 commit，不会漂移。

**为什么有些插件是 git 来源？**
仓库没有发布 npm 包，但安装命令明确写了 `github:<自己>`。构建会读 `HEAD:package.json` 拿版本、把 commit 固定下来，安装时走 `git+https://github.com/...#<commit>`。

**为什么分类是 other？**
分类是规则 + 标签统计推断的，拿不准就归 `other`（当前约 13%），不影响安装，只影响筛选体验。

**DSH 里多久能看到更新？**
上游 03:00 / 06:00（北京时间）更新，本索引 08:30 构建；raw CDN 缓存 5 分钟，DSH 自身缓存 10 分钟。

**可以用 jsDelivr 吗？**
可以，但它对分支文件的缓存可能到 12 小时，且不保证与 raw 同步；急用走 raw。

## 来源与许可

- 上游目录：[2BingLing/dsh-market](https://github.com/2BingLing/dsh-market)（MIT；`dsh.market` 名称、logo、域名为保留的品牌资产）。
- 转换代码：[master 分支](https://github.com/Kangmori/dsh-market)，MIT。
- 本分支只包含生成产物，不代表上游作者立场，也不使用 `dsh.market` 品牌。

<details>
<summary>English</summary>

A daily-generated plugin market index (DSH format 1) built from [2BingLing/dsh-market](https://github.com/2BingLing/dsh-market)'s `plugins.json`. It currently lists **8,388 plugins** (5,454 npm, 2,934 git) and is validated with DSH's official `parseMarketIndex`.

Add the raw URL above as a market index source in DSH. This branch is generated output: the converter and workflow live on [master](https://github.com/Kangmori/dsh-market). Do not edit files here by hand — every build force-pushes a fresh commit.

</details>
