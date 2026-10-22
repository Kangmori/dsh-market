#!/usr/bin/env node
'use strict';
/**
 * Convert the legacy `plugins.json` catalogue (schemaVersion 2) into a
 * DeepSeek Harness plugin-market index (format 1), the format that
 * `@deepseek-ai/dsh-plugin-market-index` validates and the Discover page reads.
 *
 * The legacy file carries no version data at all, while format 1 requires at
 * least one `versions[]` entry with an exact SemVer and a publish timestamp.
 * The converter therefore resolves each plugin to its npm package:
 *
 *   1. `index.json` already maps 2.5k GitHub repositories to their npm package,
 *      version and DSH engine range -> used as an offline reference dictionary.
 *   2. `install.commands` often names the package (`dsh plugin add <pkg>`).
 *   3. The npm package page in `homepage`, and `npm i <pkg>` in `readmeSummary`.
 *   4. Last resort: the repository name, and `@owner/<repo>` as a scope guess.
 *
 * Everything outside step 1 is verified: against the npm registry, the
 * package's `repository` field must point at the same GitHub repository, so a
 * guessed name is never accepted on name alone. With `--github`, plugins whose
 * install command names their own repository get a Git fallback: the default
 * branch's `package.json` supplies the version and its commit pins the source.
 * Failures are reported, never fabricated: an entry with no resolvable source
 * is dropped from the index.
 *
 * Usage:
 *   node tools/convert.js --probe 300          # sample + hit-rate report only
 *   node tools/convert.js                      # full conversion (npm only)
 *   node tools/convert.js --github             # + Git fallback via GitHub
 *   node tools/convert.js --offline            # index.json-backed entries only
 *   node tools/convert.js --min-stars 5 --out index.min5.json
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { execSync } = require('node:child_process');

// ---------------------------------------------------------------- utilities

function parseArgs(argv) {
  const out = {
    plugins: 'plugins.json',
    index: 'index.json',
    out: 'index.from-plugins.json',
    report: 'conversion-report.json',
    cache: '.work/npm-cache',
    concurrency: 32,
    timeoutMs: 20000,
    probe: 0,
    stride: 0,
    limit: 0,
    minStars: 0,
    maxKeywords: 10,
    offline: false,
    github: false,
    githubCache: '.work/github-cache',
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--plugins') out.plugins = next();
    else if (a === '--index') out.index = next();
    else if (a === '--out') out.out = next();
    else if (a === '--report') out.report = next();
    else if (a === '--cache') out.cache = next();
    else if (a === '--concurrency') out.concurrency = Number(next());
    else if (a === '--probe') out.probe = Number(next());
    else if (a === '--stride') out.stride = Number(next());
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--min-stars') out.minStars = Number(next());
    else if (a === '--max-keywords') out.maxKeywords = Number(next());
    else if (a === '--offline') out.offline = true;
    else if (a === '--github') out.github = true;
    else if (a === '--github-cache') out.githubCache = next();
    else if (a === '--quiet') out.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const PACKAGE_NAME_MAX_LENGTH = 214;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:(?:0|[1-9]\d*)|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;
const MAX_PUBLISH_TIMESTAMP = 1e11;

function isPackageName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= PACKAGE_NAME_MAX_LENGTH && PACKAGE_NAME.test(name);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** SemVer precedence, enough for choosing the highest stable release. */
function compareSemver(a, b) {
  const pa = a.split('+')[0];
  const pb = b.split('+')[0];
  const [ma, ra] = pa.split('-', 2);
  const [mb, rb] = pb.split('-', 2);
  const na = ma.split('.').map(Number);
  const nb = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (na[i] !== nb[i]) return na[i] - nb[i];
  if (ra === undefined && rb === undefined) return 0;
  if (ra === undefined) return 1;
  if (rb === undefined) return -1;
  const sa = ra.split('.');
  const sb = rb.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] === undefined) return -1;
    if (sb[i] === undefined) return 1;
    const na2 = /^\d+$/.test(sa[i]);
    const nb2 = /^\d+$/.test(sb[i]);
    if (na2 && nb2) {
      const d = Number(sa[i]) - Number(sb[i]);
      if (d !== 0) return d;
    } else if (na2 !== nb2) return na2 ? -1 : 1;
    else if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
  }
  return 0;
}

/** `owner/repo` from any GitHub URL shape npm users write into `repository`. */
function githubSlug(value) {
  if (typeof value !== 'string') return undefined;
  let text = value.trim();
  text = text.replace(/^git\+/i, '').replace(/^github:/i, 'https://github.com/');
  text = text.replace(/^git@github\.com:/i, 'https://github.com/');
  text = text.replace(/^git:\/\//i, 'https://');
  text = text.replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/');
  text = text.replace(/^https?:\/\/[^/]*@/, 'https://');
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(text);
  if (!m) return undefined;
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
}

function validHomepage(value) {
  if (!nonEmpty(value)) return undefined;
  let url;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  return url.href;
}

// ------------------------------------------------------------- index.json

/** Build the offline reference dictionary: GitHub repo -> format-1 plugin(s). */
function buildReference(index) {
  const byRepo = new Map();
  const add = (slug, plugin) => {
    if (!slug) return;
    const key = slug.toLowerCase();
    const list = byRepo.get(key) ?? [];
    list.push(plugin);
    byRepo.set(key, list);
  };
  for (const plugin of index.plugins) {
    let slug;
    const title = String(plugin.title ?? '');
    const withoutFragment = title.split('#')[0];
    if (/^[^/\s]+\/[^/\s]+$/.test(withoutFragment)) slug = withoutFragment;
    if (!slug) slug = githubSlug(plugin.repository?.url ?? '');
    if (!slug) {
      if (nonEmpty(plugin.homepage)) slug = githubSlug(plugin.homepage);
    }
    add(slug, {
      name: plugin.name,
      version: plugin.versions?.[0]?.version,
      publishTimestamp: plugin.versions?.[0]?.publishTimestamp,
      enginesDsh: plugin.versions?.[0]?.engines?.dsh,
      category: plugin.metadata?.category,
    });
  }
  return byRepo;
}

// --------------------------------------------------------------- candidates

/** Normalise one install spec found in a README or command into a package name. */
function specToName(spec) {
  let s = String(spec ?? '').trim().replace(/^["'`]|["'`]$/g, '');
  if (!s) return undefined;
  if (/^(?:github:|git\+|git@|git:\/\/|ssh:|https?:|file:|link:|npm:|\.{1,2}\/|\/|[A-Za-z]:)/.test(s)) return undefined;
  s = s.replace(/@latest$/i, '');
  // `pkg@1.2.3`, `pkg@^1`, `pkg@~1` — but keep the leading @ of a scope.
  s = s.replace(/(.)@[\^~]?[0-9].*$/, '$1');
  if (s.includes('<') || s.includes('>') || s.includes('$') || s.includes('*') || s.includes('\\')) return undefined;
  return isPackageName(s) ? s : undefined;
}

function namesFromCommands(entry) {
  const out = [];
  const push = (value) => {
    const name = specToName(value);
    if (name) out.push(name);
  };
  for (const raw of entry.install?.commands ?? []) {
    const cmd = String(raw ?? '');
    let m;
    const add = /\badd\s+("[^"]*"|'[^']*'|`[^`]*`|\S+)/g;
    while ((m = add.exec(cmd))) push(m[1]);
    const pkg = /\b(?:npm\s+(?:i|install)(?:\s+-g)?|pnpm\s+(?:add|i)(?:\s+-g)?|yarn\s+add)\s+("[^"]*"|'[^']*'|`[^`]*`|\S+)/g;
    while ((m = pkg.exec(cmd))) push(m[1]);
  }
  return out;
}

function namesFromReadme(text) {
  const out = [];
  if (!nonEmpty(text)) return out;
  const head = text.slice(0, 2000);
  const re = /\b(?:npm\s+(?:i|install)(?:\s+-g)?|pnpm\s+(?:add|i)(?:\s+-g)?|yarn\s+add)\s+(?:"|'|`)?(@?[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)?)/gi;
  let m;
  while ((m = re.exec(head))) {
    const name = specToName(m[1]);
    if (name) out.push(name);
  }
  return out;
}

function namesFromHomepage(homepage) {
  if (!nonEmpty(homepage)) return [];
  const m = /npmjs\.com\/package\/(@?[^/?#]+(?:\/[^/?#]+)?)/i.exec(homepage);
  if (!m) return [];
  const name = specToName(decodeURIComponent(m[1]));
  return name ? [name] : [];
}

/**
 * Ordered candidate package names with their evidence:
 * `index` (authoritative), `command`, `readme`, `homepage`, `guess`.
 */
function candidatesFor(entry, refs) {
  const out = [];
  const seen = new Set();
  const add = (name, source) => {
    if (!isPackageName(name) || seen.has(name)) return;
    seen.add(name);
    out.push({ name, source });
  };
  if (refs.length === 1) add(refs[0].name, 'index');
  else if (refs.length > 1) {
    const exact = refs.find((r) => r.name === entry.name || r.name.endsWith(`/${entry.name}`));
    if (exact) add(exact.name, 'index');
  }
  for (const name of namesFromCommands(entry)) add(name, 'command');
  for (const name of namesFromHomepage(entry.homepage)) add(name, 'homepage');
  for (const name of namesFromReadme(entry.readmeSummary)) add(name, 'readme');
  add(entry.name, 'guess');
  const owner = String(entry.owner ?? '').toLowerCase();
  if (/^[a-z0-9][a-z0-9._~-]*$/.test(owner)) add(`@${owner}/${entry.name}`, 'guess');
  return out;
}

// ----------------------------------------------------------------- registry

class Registry {
  constructor(dir, timeoutMs, offline) {
    this.dir = dir;
    this.timeoutMs = timeoutMs;
    this.offline = offline;
    this.memory = new Map();
    this.requests = 0;
    this.failures = 0;
  }

  cacheFile(name) {
    return path.join(this.dir, `${encodeURIComponent(name)}.json`);
  }

  async load(name) {
    if (this.memory.has(name)) return this.memory.get(name);
    let value = null;
    try {
      value = JSON.parse(await fsp.readFile(this.cacheFile(name), 'utf8'));
    } catch { /* not cached */ }
    this.memory.set(name, value);
    return value;
  }

  async save(name, value) {
    this.memory.set(name, value);
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.cacheFile(name), JSON.stringify(value));
  }

  /** Minimal packument facts, or null when the package does not exist. */
  async get(name) {
    const cached = await this.load(name);
    if (cached !== null) return cached;
    if (this.offline) return null;
    const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
    const url = `https://registry.npmjs.org/${encoded}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt === 2) { this.failures++; return null; }
        await sleep(500 * (attempt + 1));
        continue;
      }
      this.requests++;
      if (res.status === 404) {
        await this.save(name, { missing: true });
        return { missing: true };
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        if (attempt === 2) { this.failures++; return null; }
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        this.failures++;
        return null;
      }
      let doc;
      try { doc = await res.json(); } catch { this.failures++; return null; }
      const value = summarisePackument(doc, name);
      await this.save(name, value);
      return value;
    }
    return null;
  }
}

function summarisePackument(doc, name) {
  if (!doc || typeof doc !== 'object' || !doc.versions) return { missing: true };
  const times = doc.time ?? {};
  const versions = Object.keys(doc.versions).filter((v) => SEMVER.test(v));
  if (versions.length === 0) return { missing: true };
  const stable = versions.filter((v) => !v.split('+')[0].includes('-'));
  const latestTag = doc['dist-tags']?.latest;
  let pick;
  if (latestTag && versions.includes(latestTag) && Number.isFinite(Date.parse(times[latestTag]))) pick = latestTag;
  else {
    const pool = (stable.length ? stable : versions).slice().sort(compareSemver);
    pick = pool[pool.length - 1];
  }
  if (!pick) return { missing: true };
  const ts = Math.floor(Date.parse(times[pick]) / 1000);
  if (!Number.isFinite(ts) || ts < 0 || ts >= MAX_PUBLISH_TIMESTAMP) return { missing: true };
  const repository = typeof doc.repository === 'string' ? doc.repository : doc.repository?.url;
  return {
    name: doc.name ?? name,
    repository: githubSlug(repository) ?? githubSlug(doc.homepage),
    version: pick,
    publishTimestamp: ts,
    enginesDsh: typeof doc.versions[pick]?.engines?.dsh === 'string' ? doc.versions[pick].engines.dsh : undefined,
  };
}

/** Resolve one entry; each candidate is verified against the GitHub repository. */
async function resolveEntry(entry, refs, registry) {
  const candidates = candidatesFor(entry, refs);
  for (const candidate of candidates) {
    const facts = await registry.get(candidate.name);
    if (!facts || facts.missing) continue;
    if (candidate.source !== 'index') {
      const sameRepo = facts.repository && facts.repository.toLowerCase() === String(entry.fullName).toLowerCase();
      // A package without repository metadata is accepted only when the repo
      // name and the package name agree exactly.
      const nameOnly = !facts.repository && candidate.name === entry.name;
      if (!sameRepo && !nameOnly) continue;
    }
    return { ...facts, source: candidate.source, candidate: candidate.name };
  }
  return null;
}

// ------------------------------------------------------------------- github

/**
 * An entry is eligible for the Git fallback only when its own install command
 * names its own repository (`github:owner/repo`, `git+https://github.com/...`,
 * or a plain `git clone`). This keeps unrelated repositories that merely
 * mention DSH out of the catalogue.
 */
function gitCommandMatches(entry) {
  const full = String(entry.fullName).toLowerCase();
  for (const raw of entry.install?.commands ?? []) {
    const cmd = String(raw);
    for (const re of [
      /github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i,
      /git\+https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[#\s"'`]|$)/i,
      /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[#\s"'`]|$)/i,
    ]) {
      const m = re.exec(cmd);
      if (m && m[1].toLowerCase() === full) return true;
    }
  }
  return false;
}

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function packageJsonFacts(text) {
  try {
    const pkg = JSON.parse(text);
    return {
      name: typeof pkg.name === 'string' ? pkg.name : undefined,
      version: typeof pkg.version === 'string' ? pkg.version : undefined,
      enginesDsh: typeof pkg.engines?.dsh === 'string' ? pkg.engines.dsh : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Batch-read `HEAD:package.json` and the default-branch commit for many repos. */
async function resolveGitHub(fullNames, cacheDir, token, concurrency = 4) {
  const out = new Map();
  if (!token) return out;
  const queue = [...new Set(fullNames.map((n) => n.toLowerCase()))];
  const cached = new Map();
  const cacheFile = (slug) => path.join(cacheDir, `${slug.replace('/', '__')}.json`);

  const missing = [];
  for (const slug of queue) {
    try {
      cached.set(slug, JSON.parse(await fsp.readFile(cacheFile(slug), 'utf8')));
    } catch {
      missing.push(slug);
    }
  }
  for (const [slug, value] of cached) out.set(slug, value);

  const batches = [];
  for (let i = 0; i < missing.length; i += 50) batches.push(missing.slice(i, i + 50));
  let done = 0;

  async function runBatch(batch) {
    const parts = batch.map((slug, i) => {
      const [owner, name] = slug.split('/');
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
        nameWithOwner
        defaultBranchRef { target { ... on Commit { oid committedDate } } }
        object(expression: "HEAD:package.json") { ... on Blob { text } }
      }`;
    });
    const query = `query {\n${parts.join('\n')}\n}`;
    let json;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await fetch('https://api.github.com/graphql', {
          method: 'POST',
          headers: {
            authorization: `bearer ${token}`,
            'content-type': 'application/json',
            'user-agent': 'dsh-market-converter',
          },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(60000),
        });
      } catch {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
        const wait = Math.max(0, reset - Date.now());
        if (wait > 120000) return; // do not stall the whole conversion
        await sleep(Math.min(wait + 1000, 60000));
        continue;
      }
      if (!res.ok) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      json = await res.json();
      break;
    }
    if (!json) return;
    const data = json.data ?? {};
    for (let i = 0; i < batch.length; i++) {
      const node = data[`r${i}`];
      const slug = batch[i];
      let value = null;
      if (node) {
        const pkg = node.object?.text ? packageJsonFacts(node.object.text) : undefined;
        value = {
          commit: node.defaultBranchRef?.target?.oid,
          committedDate: node.defaultBranchRef?.target?.committedDate,
          packageName: pkg?.name,
          version: pkg?.version,
          enginesDsh: pkg?.enginesDsh,
        };
      }
      out.set(slug, value);
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(cacheFile(slug), JSON.stringify(value));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (true) {
      const batch = batches.shift();
      if (!batch) return;
      await runBatch(batch);
      done += batch.length;
      if (done % 1000 < 50) log(`github repos scanned: ${done}/${missing.length}`);
    }
  });
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------------- categories

/**
 * Surface keywords that identify a category, checked against the plugin name
 * and both descriptions before the statistical tag model is consulted.
 */
const CATEGORY_RULES = [
  ['theme', ['theme', 'skin', 'wallpaper', '主题', '皮肤', '壁纸', '外观', '配色', '色系', '毛玻璃', '暗色', '亮色']],
  ['memory', ['memory', '记忆', '回忆', '知识库', 'knowledge base']],
  ['voice', ['voice', 'audio', 'tts', 'asr', 'speech', '语音', '音频', '朗读', '播报', '声音']],
  ['vision', ['vision', 'ocr', 'image', '视觉', '图像', '图片', '看图', '识图', '截图']],
  ['notify', ['notify', 'notification', '通知', '提醒', '告警', '铃声']],
  ['usage', ['usage', 'quota', 'balance', 'billing', 'cost', 'token', '用量', '额度', '余额', '计费', '费用', '账单']],
  ['model', ['model', 'provider', '模型', '供应商', '路由', '切换模型', '账号接入']],
  ['identity', ['auth', 'oauth', 'login', 'sso', '登录', '认证', '身份', '账号']],
  ['security', ['security', 'sandbox', 'permission', 'audit', '安全', '权限', '沙箱', '审计', '审批']],
  ['git', ['git', 'commit', 'diff', 'pull request', 'code review', '评审', '版本控制']],
  ['docs', ['document', 'pdf', 'docx', 'pptx', 'excel', 'markdown', '文档', '渲染', '幻灯片']],
  ['browser', ['browser', '浏览器', 'web search', '联网', '网页', '抓取', '爬虫']],
  ['session', ['session', 'conversation', '会话', '对话', '聊天记录', '消息']],
  ['skill', ['skill', '技能']],
  ['market', ['market', 'marketplace', '插件市场', '商店', '市场']],
  ['workflow', ['workflow', 'automation', '工作流', '自动化', '编排', '定时任务']],
  ['wsl', ['wsl', 'windows 互操作']],
  ['remote', ['remote', 'mobile', '远程', '手机', '局域网', '跨设备']],
  ['fun', ['game', 'pet', 'meme', '游戏', '宠物', '娱乐', '桌宠', '表情']],
  ['dev', ['debug', 'build', 'compile', 'runtime', '开发', '调试', '编译', '日志', '架构']],
  ['ui', ['sidebar', '侧边栏', 'input', 'composer', '输入框', 'layout', '布局', 'panel', '面板', 'ui', '界面', '按钮', '工具栏', '菜单', '字体', '显示']],
];

function ruleCategory(entry) {
  const text = [entry.name, entry.description, entry.descriptionZh, entry.fullName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const scores = new Map();
  for (const [category, words] of CATEGORY_RULES) {
    for (const word of words) {
      if (!text.includes(word)) continue;
      const weight = word.length >= 4 ? 2 : 1;
      const inName = String(entry.name).toLowerCase().includes(word) ? 2 : 1;
      scores.set(category, (scores.get(category) ?? 0) + weight * inName);
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return undefined;
  const [best, score] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  if (score < 3 || score < second * 1.5) return undefined;
  return best;
}

/** Learn tag -> category weights from the entries index.json already labels. */
function learnCategories(entries, reference, categoryTitles) {
  const docFreq = new Map();
  for (const entry of entries) {
    for (const tag of allTags(entry)) docFreq.set(tag, (docFreq.get(tag) ?? 0) + 1);
  }
  const total = entries.length;
  const weights = new Map();
  let learned = 0;
  for (const entry of entries) {
    const refs = reference.get(String(entry.fullName).toLowerCase()) ?? [];
    const category = refs.find((r) => r.category)?.category;
    if (!category || !Object.hasOwn(categoryTitles, category)) continue;
    learned++;
    for (const tag of allTags(entry)) {
      // A tag every second plugin carries cannot discriminate between categories.
      if ((docFreq.get(tag) ?? 0) > total * 0.2) continue;
      let map = weights.get(tag);
      if (!map) { map = new Map(); weights.set(tag, map); }
      map.set(category, (map.get(category) ?? 0) + 1);
    }
  }
  return { weights, docFreq, total, learned };
}

function allTags(entry) {
  const out = new Set();
  for (const tag of [...(entry.topics ?? []), ...(entry.tags ?? [])]) {
    if (typeof tag !== 'string') continue;
    const text = tag.trim().toLowerCase();
    if (text) out.add(text);
  }
  return [...out];
}

function inferCategory(entry, learned, categoryTitles) {
  const byRule = ruleCategory(entry);
  if (byRule && Object.hasOwn(categoryTitles, byRule)) return { category: byRule, confidence: 1 };
  const scores = new Map();
  for (const tag of allTags(entry)) {
    const map = learned.weights.get(tag);
    if (!map) continue;
    const idf = Math.log(1 + learned.total / Math.max(1, learned.docFreq.get(tag) ?? 1));
    let sum = 0;
    for (const count of map.values()) sum += count;
    for (const [category, count] of map) {
      scores.set(category, (scores.get(category) ?? 0) + (count / sum) * idf);
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { category: 'other', confidence: 0 };
  const [best, score] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  if (score < 1.5 || score < second * 1.2) return { category: 'other', confidence: 0 };
  return { category: best, confidence: score / Math.max(1, second) };
}

// --------------------------------------------------------------- building

function buildPlugin(entry, facts, category) {
  let description;
  if (nonEmpty(entry.description)) {
    description = { en: entry.description.trim() };
    if (nonEmpty(entry.descriptionZh)) description.zh = entry.descriptionZh.trim();
  } else if (nonEmpty(entry.descriptionZh)) {
    // A localized object must contain `en`; a plain string is the honest shape
    // for an entry that only ever had Chinese text.
    description = entry.descriptionZh.trim();
  }
  const homepage = validHomepage(entry.homepage);
  const keywords = [];
  for (const tag of allTags(entry)) {
    if (keywords.length >= 10) break;
    if (tag.length <= 40 && !keywords.includes(tag)) keywords.push(tag);
  }
  const plugin = {
    name: facts.name,
    title: String(entry.fullName),
    ...(description === undefined ? {} : { description }),
    ...(homepage ? { homepage } : {}),
    repository: { url: `https://github.com/${entry.fullName}` },
    author: String(entry.owner),
    metadata: {
      category,
      keywords,
      labels: [],
      sortKeys: {
        stars: Number(entry.stars) || 0,
        score: Number(entry.score?.total) || 0,
      },
    },
    versions: [
      {
        version: facts.version,
        publishTimestamp: facts.publishTimestamp,
        source: facts.sourceType === 'git'
          ? { type: 'git', url: `https://github.com/${entry.fullName}`, commit: facts.commit }
          : { type: 'npm' },
        engines: facts.enginesDsh ? { dsh: facts.enginesDsh } : {},
      },
    ],
  };
  return plugin;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      done++;
      if (done % 250 === 0) log(`resolved ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// ------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  log(`reading ${args.plugins} and ${args.index}`);
  const legacy = JSON.parse(fs.readFileSync(args.plugins, 'utf8'));
  const index = JSON.parse(fs.readFileSync(args.index, 'utf8'));
  if (!Array.isArray(legacy.plugins)) throw new Error('plugins.json has no plugins array');
  if (index.format !== 1) throw new Error('index.json is not format 1');

  const reference = buildReference(index);
  const categoryTitles = index.metadata?.categories ?? {};
  const learned = learnCategories(legacy.plugins, reference, categoryTitles);
  log(`reference repos: ${reference.size}; category training rows: ${learned.learned}`);

  let entries = legacy.plugins.filter((p) => (Number(p.stars) || 0) >= args.minStars);
  if (args.stride > 0) entries = entries.filter((_, i) => i % args.stride === 0);
  if (args.limit > 0) entries = entries.slice(0, args.limit);
  if (args.probe > 0) {
    const step = Math.max(1, Math.floor(entries.length / args.probe));
    entries = entries.filter((_, i) => i % step === 0).slice(0, args.probe);
  }
  log(`candidates: ${entries.length}${args.probe ? ` (probe of ${args.probe})` : ''}${args.offline ? ' [offline]' : ''}`);

  const registry = new Registry(args.cache, args.timeoutMs, args.offline);
  const outcomes = await mapLimit(entries, args.concurrency, async (entry) => {
    const refs = reference.get(String(entry.fullName).toLowerCase()) ?? [];
    const facts = await resolveEntry(entry, refs, registry);
    return { entry, facts, bySource: facts?.source, candidates: candidatesFor(entry, refs).length };
  });

  let resolved = outcomes.filter((o) => o.facts);
  let unresolved = outcomes.filter((o) => !o.facts);

  if (args.github && !args.offline) {
    const eligible = unresolved.filter((o) => gitCommandMatches(o.entry));
    log(`git fallback candidates (own repo in install command): ${eligible.length}`);
    const token = githubToken();
    if (!token) {
      log('no GitHub token (set GITHUB_TOKEN or log in with gh); skipping the git fallback');
    } else {
      const scanned = await resolveGitHub(eligible.map((o) => o.entry.fullName), args.githubCache, token);
      let addedNpm = 0;
      let addedGit = 0;
      for (const outcome of eligible) {
        const full = String(outcome.entry.fullName).toLowerCase();
        const facts = scanned.get(full);
        if (!facts?.commit) continue;
        if (facts.packageName && isPackageName(facts.packageName)) {
          const npm = await registry.get(facts.packageName);
          if (npm && !npm.missing && (!npm.repository || npm.repository.toLowerCase() === full)) {
            outcome.facts = { ...npm, source: 'github-npm' };
            outcome.bySource = 'github-npm';
            addedNpm++;
            continue;
          }
        }
        const committedAt = Date.parse(facts.committedDate ?? '');
        if (facts.version && SEMVER.test(facts.version) && Number.isFinite(committedAt)) {
          const ts = Math.floor(committedAt / 1000);
          // Git sources carry no install spec built from the name, but format 1
          // still requires a valid, unique npm package name.
          const fallbackName = String(outcome.entry.name ?? '').toLowerCase();
          const name = isPackageName(facts.packageName) ? facts.packageName : fallbackName;
          if (!isPackageName(name)) continue;
          if (ts >= 0 && ts < MAX_PUBLISH_TIMESTAMP) {
            outcome.facts = {
              name,
              version: facts.version,
              publishTimestamp: ts,
              enginesDsh: facts.enginesDsh,
              source: 'github-git',
              sourceType: 'git',
              commit: facts.commit,
            };
            outcome.bySource = 'github-git';
            addedGit++;
          }
        }
      }
      resolved = outcomes.filter((o) => o.facts);
      unresolved = outcomes.filter((o) => !o.facts);
      log(`git fallback added: npm=${addedNpm}, git=${addedGit}`);
    }
  }
  const bySource = new Map();
  for (const o of resolved) {
    const key = o.bySource ?? o.facts.source;
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }

  if (args.probe > 0) {
    const summary = {
      sampled: entries.length,
      resolved: resolved.length,
      unresolved: unresolved.length,
      hitRate: resolved.length / Math.max(1, entries.length),
      bySource: Object.fromEntries(bySource),
      requests: registry.requests,
      seconds: (Date.now() - started) / 1000,
      unresolvedSample: unresolved.slice(0, 20).map((o) => `${o.entry.fullName} | ${(o.entry.install?.commands ?? [])[0] ?? '-'}`),
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // One package can back several repositories; keep the most-starred entry.
  const byPackage = new Map();
  let duplicates = 0;
  for (const outcome of resolved) {
    const name = outcome.facts.name;
    const existing = byPackage.get(name);
    if (existing === undefined || (Number(outcome.entry.stars) || 0) > (Number(existing.entry.stars) || 0)) {
      if (existing !== undefined) duplicates++;
      byPackage.set(name, outcome);
    } else duplicates++;
  }

  const usedCategories = new Map();
  const plugins = [];
  let otherCount = 0;
  for (const outcome of byPackage.values()) {
    const refs = reference.get(String(outcome.entry.fullName).toLowerCase()) ?? [];
    const fromIndex = refs.find((r) => r.category)?.category;
    let category;
    if (outcome.facts.source === 'index' && fromIndex && Object.hasOwn(categoryTitles, fromIndex)) {
      category = fromIndex;
    } else {
      const guessed = inferCategory(outcome.entry, learned, categoryTitles).category;
      category = Object.hasOwn(categoryTitles, guessed) ? guessed : 'other';
    }
    if (category === 'other') otherCount++;
    usedCategories.set(category, (usedCategories.get(category) ?? 0) + 1);
    plugins.push(buildPlugin(outcome.entry, outcome.facts, category));
  }

  plugins.sort((a, b) => {
    const sa = a.metadata.sortKeys.score;
    const sb = b.metadata.sortKeys.score;
    if (sa !== sb) return sb - sa;
    const ta = a.metadata.sortKeys.stars;
    const tb = b.metadata.sortKeys.stars;
    if (ta !== tb) return tb - ta;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const categories = { ...categoryTitles, other: { title: { en: 'Other', zh: '其他' } } };
  const declared = {};
  for (const id of Object.keys(categories)) {
    if (id === 'other' || usedCategories.has(id)) declared[id] = categories[id];
  }

  const document = {
    format: 1,
    title: {
      en: 'DSH Plugin Catalogue',
      zh: 'DSH 插件总目录',
    },
    description: {
      en: "Community DSH plugins converted from the plugins.json catalogue. A version comes from the npm registry, or from the repository's package.json for a Git-only plugin.",
      zh: '由 plugins.json 目录转换而来的社区 DSH 插件；版本号取自 npm registry，纯 Git 插件取自仓库的 package.json。',
    },
    metadata: {
      categories: declared,
      labels: {},
      sortKeys: {
        stars: { title: { en: 'GitHub stars', zh: 'GitHub 星标' }, order: 'desc' },
        score: { title: { en: 'Catalogue score', zh: '目录评分' }, order: 'desc' },
      },
    },
    plugins,
  };

  const json = JSON.stringify(document);
  fs.writeFileSync(args.out, json);

  const report = {
    generatedAt: new Date().toISOString(),
    sources: { plugins: args.plugins, index: args.index },
    inputPlugins: legacy.plugins.length,
    considered: entries.length,
    resolved: resolved.length,
    dropped: unresolved.length,
    duplicates,
    outputPlugins: plugins.length,
    bySource: Object.fromEntries(bySource),
    bySourceType: (() => {
      const counts = new Map();
      for (const plugin of plugins) for (const version of plugin.versions) counts.set(version.source.type, (counts.get(version.source.type) ?? 0) + 1);
      return Object.fromEntries(counts);
    })(),
    byCategory: Object.fromEntries([...usedCategories.entries()].sort((a, b) => b[1] - a[1])),
    otherCategory: otherCount,
    npmRequests: registry.requests,
    npmFailures: registry.failures,
    outputBytes: Buffer.byteLength(json),
    seconds: (Date.now() - started) / 1000,
    droppedReasons: (() => {
      const buckets = new Map();
      for (const o of unresolved) {
        const commands = o.entry.install?.commands ?? [];
        const githubOnly = commands.length > 0 && commands.every((c) => /github:|git\+|git clone|\.tgz/.test(c));
        const reason = commands.length === 0 ? 'no-install-command' : githubOnly ? 'git-or-tarball-only' : 'npm-package-not-found';
        buckets.set(reason, (buckets.get(reason) ?? 0) + 1);
      }
      return Object.fromEntries(buckets);
    })(),
  };
  fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
  log(`wrote ${args.out} (${plugins.length} plugins, ${(report.outputBytes / 1048576).toFixed(2)} MiB)`);
  log(`wrote ${args.report}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
