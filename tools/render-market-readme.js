#!/usr/bin/env node
'use strict';
/**
 * Render the README that ships with the published index on the `market` branch.
 * Reads public/meta.json + public/conversion-report.json and writes public/README.md,
 * so every daily build refreshes the numbers instead of leaving a stale hand-written page.
 */
const fs = require('node:fs');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const meta = readJson('public/meta.json');
const report = readJson('public/conversion-report.json');
const bytes = fs.statSync('public/index.json').size;

const mib = (n) => `${(n / 1048576).toFixed(2)} MiB`;
const utc = (iso) => (iso ? `${iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}` : '未知');
const pct = (part, whole) => `${((part / whole) * 100).toFixed(1)}%`;

const categories = report.byCategory ?? {};
const categoryCount = Object.keys(categories).length;
const other = report.otherCategory ?? 0;
const sourceTypes = report.bySourceType ?? {};
const npmCount = sourceTypes.npm ?? 0;
const gitCount = sourceTypes.git ?? 0;
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : undefined;
const repoUrl = process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}`
  : 'https://github.com/Kangmori/dsh-market';

const topCategories = Object.entries(categories)
  .slice(0, 8)
  .map(([id, count]) => `\`${id}\` ${count.toLocaleString('en-US')}`)
  .join(' · ');

const readme = `# DSH 插件索引（format 1）

由 [2BingLing/dsh-market](${meta.upstream}) 每日产出的 \`data/plugins.json\` 自动转换而来。

> **本分支是构建产物，请勿手改。** 每次构建都会用新的 orphan commit 强制覆盖；要改内容请改 [master 分支](${repoUrl}) 的 \`tools/convert.js\` 或 \`.github/workflows/build-dsh-index.yml\`。

## 在 DSH 中使用

把这个地址加到 DSH 的插件市场索引源（Settings → Plugins / Discover → 索引源，配置项 \`plugin-market.indexes\`）：

\`\`\`
${meta.indexUrl}
\`\`\`

\`raw.githubusercontent.com\` 直接返回 200，不重定向（DSH 抓取时 \`redirect: 'error'\`，所以不能用 \`github.com/.../raw/...\`）。

中国大陆网络如果访问 raw 不稳定，可试 jsDelivr 镜像（缓存时间更长）：

\`\`\`
https://cdn.jsdelivr.net/gh/${process.env.GITHUB_REPOSITORY ?? 'Kangmori/dsh-market'}@market/index.json
\`\`\`

## 当前构建

| 项目 | 值 |
|---|---|
| 上游数据时间 | ${utc(meta.upstreamGeneratedAt)} |
| 本次构建 | ${utc(meta.generatedAt)} |
| 插件数 | **${meta.plugins.toLocaleString('en-US')}** |
| 来源 | npm ${npmCount.toLocaleString('en-US')}（${pct(npmCount, meta.plugins)}） · git ${gitCount.toLocaleString('en-US')}（${pct(gitCount, meta.plugins)}） |
| 分类 | ${categoryCount} 个；\`other\` ${other.toLocaleString('en-US')}（${pct(other, meta.plugins)}） |
| 主要分类 | ${topCategories} |
| 文件大小 | ${mib(bytes)} |
| 校验 | DSH 官方 \`parseMarketIndex\` 通过${runUrl ? `（[构建日志](${runUrl})）` : ''} |

## 本分支文件

| 文件 | 用途 |
|---|---|
| \`index.json\` | format 1 索引，DSH 直接读取 |
| \`meta.json\` | 构建元数据：上游时间、条数、来源统计、索引地址 |
| \`conversion-report.json\` | 转换明细：各来源计数、丢弃原因、分类分布 |
| \`README.md\` | 本文件，构建时自动生成 |

## 数据是怎么来的

上游 \`plugins.json\` 是 GitHub 仓库目录（\`schemaVersion 2\`），**没有任何版本字段**；而 format 1 要求每条插件至少一个精确 SemVer、发布时间和 \`npm\`/\`git\` 来源。因此不能靠字段改名，构建分四步：

1. 用公开的 awesome-dsh-plugin 索引反查 npm 包名 / 版本 / \`engines.dsh\` / 分类；
2. 从 \`install.commands\`、README、homepage 提取候选包名，查 npm registry，并用包的 \`repository\` 字段核对同一个 GitHub 仓库；
3. 对显式声明 \`github:<自身仓库>\` 安装方式的插件，用 GitHub GraphQL 读默认分支 \`package.json\` 与 commit，生成固定 commit 的 \`git\` 来源；
4. 同名包去重、分类推断、声明 \`stars\`/\`score\` 排序键，最后用官方 parser 校验。

构建脚本在 master 分支：[workflow](${repoUrl}/blob/master/.github/workflows/build-dsh-index.yml)、[convert.js](${repoUrl}/blob/master/tools/convert.js)、[validate.js](${repoUrl}/blob/master/tools/validate.js)。

## 更新节奏

- 上游：北京时间 03:00 主采集、06:00 兜底（UTC 19:00 / 22:00）。
- 本索引：北京时间 **08:30** 自动构建（UTC 00:30），冷跑约 5 分钟，热跑 1–2 分钟。
- raw CDN 缓存 5 分钟；jsDelivr 缓存可能到 12 小时，急用请走 raw。

## 口径与限制

- **版本**：npm 来源取构建时刻的 latest；git 来源的版本取自仓库 \`package.json\`，commit 固定。
- **分类**：规则 + 标签统计的推断值，不确定归 \`other\`，不要当权威元数据。
- **收录范围**：只保留能证明来源的插件；无法解析 npm/git 的条目会被丢弃，原因见 \`conversion-report.json\`。
- **无签名**：索引内容来自第三方目录与公开 registry，是市场的声明，不构成安装背书；装什么以安装清单为准。

## 来源与许可

- 上游目录：[2BingLing/dsh-market](${meta.upstream})（MIT；\`dsh.market\` 名称、logo、域名为保留的品牌资产）。
- 转换代码：[master 分支](${repoUrl})，MIT。
- 本分支只包含生成产物，不代表上游作者立场，也不使用 \`dsh.market\` 品牌。
`;

fs.writeFileSync('public/README.md', readme);
console.log(`wrote public/README.md (${Buffer.byteLength(readme)} bytes)`);
