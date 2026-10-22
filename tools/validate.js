#!/usr/bin/env node
'use strict';
/**
 * Standalone checker for a DeepSeek Harness plugin-market index (format 1).
 *
 * The rules mirror `@deepseek-ai/dsh-plugin-market-index`'s `parseMarketIndex`
 * (the validator the DSH Host runs on every fetched index). When that package
 * (or a copy of it) is available, `--official <path-to-lib/index.js>` runs the
 * authoritative implementation instead of this mirror.
 *
 * Usage:
 *   node tools/validate.js index.from-plugins.json
 *   node tools/validate.js index.json --url https://example.com/index.json
 *   node tools/validate.js out.json --official .work/official/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js
 */

const fs = require('node:fs');

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const PACKAGE_NAME_MAX_LENGTH = 214;
const NUMERIC = '(?:0|[1-9]\\d*)';
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u');
const COMMIT = /^[0-9a-f]{40}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_INLINE_ICON_BYTES = 32 * 1024;
const MAX_PUBLISH_TIMESTAMP = 1e11;

class IndexError extends Error {
  constructor(path, reason) {
    super(`${path} ${reason}`);
    this.path = path;
    this.reason = reason;
  }
}

const fail = (path, reason) => { throw new IndexError(path, reason); };
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function objectAt(value, path) {
  if (!isObject(value)) fail(path, 'must be an object');
  return value;
}
function stringAt(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a string with a non-whitespace character');
  return value;
}
function optional(object, key, path, read) {
  return Object.hasOwn(object, key) ? read(object[key], `${path}.${key}`) : undefined;
}
function localizedText(value, path) {
  if (typeof value === 'string') return stringAt(value, path);
  const object = objectAt(value, path);
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${path}.${language}`, 'must be keyed by a lowercase language id');
    stringAt(member, `${path}.${language}`);
  }
  if (!Object.hasOwn(object, 'en')) fail(path, 'must contain en');
  return object;
}
function declarations(value, path, read) {
  const result = {};
  for (const [id, member] of Object.entries(objectAt(value, path))) {
    if (id === '') fail(path, 'must not declare an empty id');
    result[id] = read(objectAt(member, `${path}.${id}`), `${path}.${id}`);
  }
  return result;
}
function declaration(object, path) {
  return { title: localizedText(object.title, `${path}.title`) };
}
function sortKeyDeclaration(object, path) {
  if (object.order !== 'asc' && object.order !== 'desc') fail(`${path}.order`, 'must be "asc" or "desc"');
  return { title: localizedText(object.title, `${path}.title`), order: object.order };
}
function declaredId(value, path, declared) {
  const id = stringAt(value, path);
  if (!Object.hasOwn(declared, id)) fail(path, `references undeclared id ${JSON.stringify(id)}`);
  return id;
}
function pluginMetadata(value, path, index) {
  const object = value === undefined ? {} : objectAt(value, path);
  const category = optional(object, 'category', path, (m, at) => declaredId(m, at, index.categories));
  const keywords = optional(object, 'keywords', path, (m, at) => {
    if (!Array.isArray(m)) fail(at, 'must be an array');
    return m.map((k, i) => {
      if (typeof k !== 'string') fail(`${at}[${String(i)}]`, 'must be a string');
      return k;
    });
  }) ?? [];
  const labels = optional(object, 'labels', path, (m, at) => {
    if (!Array.isArray(m)) fail(at, 'must be an array');
    const ids = m.map((l, i) => declaredId(l, `${at}[${String(i)}]`, index.labels));
    if (new Set(ids).size !== ids.length) fail(at, 'must not repeat a label');
    return ids;
  }) ?? [];
  const sortKeys = optional(object, 'sortKeys', path, (m, at) => {
    const values = {};
    for (const [id, sortValue] of Object.entries(objectAt(m, at))) {
      declaredId(id, `${at}.${id}`, index.sortKeys);
      if (typeof sortValue !== 'number' || !Number.isFinite(sortValue)) fail(`${at}.${id}`, 'must be a finite number');
      values[id] = sortValue;
    }
    return values;
  }) ?? {};
  return { category, keywords, labels, sortKeys };
}
function httpUrl(value, path, protocols) {
  const text = stringAt(value, path);
  let url;
  try { url = new URL(text); } catch { fail(path, 'must be an absolute URL'); }
  if (!protocols.includes(url.protocol)) fail(path, `must use ${protocols.join(' or ')}`);
  if (url.username !== '' || url.password !== '') fail(path, 'must not contain credentials');
  if (url.href.includes('?') || url.href.includes('#')) fail(path, 'must not contain a query or fragment');
  return url;
}
function homepageUrl(value, path) {
  const text = stringAt(value, path);
  if (!URL.canParse(text)) fail(path, 'must be an absolute URL');
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(path, 'must use https: or http:');
  return url.href;
}
function gitUrl(value, path) {
  const url = httpUrl(value, path, ['https:']);
  if (url.href !== value) fail(path, 'must be a canonical URL');
  if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) fail(path, 'must name a repository with at least two path segments');
  if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) fail(path, 'must name a repository, not a tarball');
  return url.href;
}
function packagePath(value, path) {
  const text = stringAt(value, path);
  if (text.split('/').some((s) => s === '.' || s === '..' || !PATH_SEGMENT.test(s))) fail(path, 'must be a relative directory of letters, digits, and ._@+- segments without . or ..');
  return text;
}
function repository(value, path) {
  const object = objectAt(value, path);
  const url = httpUrl(object.url, `${path}.url`, ['https:', 'http:']).href;
  const directory = optional(object, 'directory', path, packagePath);
  return { url, directory };
}
function source(value, path) {
  const object = objectAt(value, path);
  if (object.type === 'npm') {
    const registry = optional(object, 'registry', path, (m, at) => httpUrl(m, at, ['https:', 'http:']).href);
    return { type: 'npm', registry };
  }
  if (object.type === 'git') {
    const commit = stringAt(object.commit, `${path}.commit`);
    if (!COMMIT.test(commit)) fail(`${path}.commit`, 'must be a lowercase 40-hex-digit commit SHA');
    const dir = optional(object, 'path', path, packagePath);
    return { type: 'git', url: gitUrl(object.url, `${path}.url`), commit, path: dir };
  }
  return fail(`${path}.type`, 'must be "npm" or "git"');
}
function engines(value, path) {
  const dsh = optional(objectAt(value, path), 'dsh', path, (m, at) => {
    const range = stringAt(m, at);
    if (range.startsWith('workspace:')) fail(at, 'must not be a workspace: range');
    return range;
  });
  return dsh === undefined ? {} : { dsh };
}
function icon(value, path, indexUrl) {
  const text = stringAt(value, path);
  if (text.startsWith('data:')) {
    const payload = DATA_ICON.exec(text)?.[1];
    if (payload === undefined || payload === '' || !BASE64.test(payload)) fail(path, 'must be a base64 SVG, PNG, JPEG, or WebP data URL');
    if (payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0) > MAX_INLINE_ICON_BYTES) fail(path, 'must not exceed 32 KiB of decoded bytes');
    return text;
  }
  let resolved;
  try { resolved = new URL(text, indexUrl); } catch { fail(path, 'must be a URL reference'); }
  if (resolved.protocol !== 'https:' && (resolved.origin === 'null' || resolved.origin !== indexUrl.origin)) fail(path, 'must resolve to https or the index origin');
  return resolved.href;
}
function marketVersion(value, path) {
  const object = objectAt(value, path);
  const version = stringAt(object.version, `${path}.version`);
  if (!SEMVER.test(version)) fail(`${path}.version`, 'must be an exact SemVer version');
  const publishTimestamp = object.publishTimestamp;
  if (typeof publishTimestamp !== 'number' || !Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    fail(`${path}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)');
  }
  return { version, publishTimestamp, source: source(object.source, `${path}.source`), engines: optional(object, 'engines', path, engines) ?? {} };
}
function versions(value, path) {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a non-empty array');
  const seen = new Set();
  return value.map((member, position) => {
    const at = `${path}[${String(position)}]`;
    const entry = marketVersion(member, at);
    if (seen.has(entry.version)) fail(`${at}.version`, `duplicates ${entry.version}`);
    seen.add(entry.version);
    return entry;
  });
}
function plugin(value, path, index, indexUrl) {
  const object = objectAt(value, path);
  const name = stringAt(object.name, `${path}.name`);
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) fail(`${path}.name`, 'must be a valid npm package name');
  const title = optional(object, 'title', path, localizedText);
  const description = optional(object, 'description', path, localizedText);
  const iconUrl = optional(object, 'icon', path, (m, at) => icon(m, at, indexUrl));
  const author = optional(object, 'author', path, stringAt);
  const homepage = optional(object, 'homepage', path, homepageUrl);
  const repo = optional(object, 'repository', path, repository);
  return { name, title, description, icon: iconUrl, author, homepage, repository: repo, metadata: pluginMetadata(object.metadata, `${path}.metadata`, index), versions: versions(object.versions, `${path}.versions`) };
}
function parseMarketIndex(value, indexUrl) {
  if (!URL.canParse(indexUrl)) fail('$', `index URL ${JSON.stringify(indexUrl)} must be an absolute URL`);
  const base = new URL(indexUrl);
  const object = objectAt(value, '$');
  if (object.format !== 1) fail('$.format', 'must be 1');
  const metadataObject = object.metadata === undefined ? {} : objectAt(object.metadata, '$.metadata');
  const metadata = {
    categories: optional(metadataObject, 'categories', '$.metadata', (m, at) => declarations(m, at, declaration)) ?? {},
    labels: optional(metadataObject, 'labels', '$.metadata', (m, at) => declarations(m, at, declaration)) ?? {},
    sortKeys: optional(metadataObject, 'sortKeys', '$.metadata', (m, at) => declarations(m, at, sortKeyDeclaration)) ?? {},
  };
  if (!Array.isArray(object.plugins)) fail('$.plugins', 'must be an array');
  const names = new Set();
  const plugins = object.plugins.map((entry, position) => {
    const parsed = plugin(entry, `$.plugins[${String(position)}]`, metadata, base);
    if (names.has(parsed.name)) fail(`$.plugins[${String(position)}].name`, `duplicates ${parsed.name}`);
    names.add(parsed.name);
    return parsed;
  });
  localizedText(object.title, '$.title');
  optional(object, 'description', '$', localizedText);
  return { format: 1, metadata, plugins };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const urlArg = args.indexOf('--url');
  const indexUrl = urlArg >= 0 ? args[urlArg + 1] : 'https://market.example.com/index.json';
  const officialArg = args.indexOf('--official');
  const officialPath = officialArg >= 0 ? args[officialArg + 1] : undefined;
  if (!file) {
    console.error('usage: node tools/validate.js <index.json> [--url <index-url>] [--official <path-to-market-index/lib/index.js>]');
    process.exit(2);
  }
  const text = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(text);
  const bytes = Buffer.byteLength(text);
  const started = Date.now();

  if (officialPath) {
    const { pathToFileURL } = require('node:url');
    const official = await import(pathToFileURL(require('node:path').resolve(officialPath)).href);
    const parsed = official.parseMarketIndex(doc, indexUrl);
    report(file, bytes, parsed, Date.now() - started, 'official');
    return;
  }

  const parsed = parseMarketIndex(doc, indexUrl);
  report(file, bytes, parsed, Date.now() - started, 'mirror');
}

function report(file, bytes, parsed, ms, impl) {
  const versions = parsed.plugins.reduce((n, p) => n + p.versions.length, 0);
  const sourceTypes = new Map();
  for (const p of parsed.plugins) for (const v of p.versions) sourceTypes.set(v.source.type, (sourceTypes.get(v.source.type) ?? 0) + 1);
  console.log(JSON.stringify({
    ok: true,
    validator: impl,
    file,
    bytes,
    ms,
    format: parsed.format,
    plugins: parsed.plugins.length,
    versions,
    sourceTypes: Object.fromEntries(sourceTypes),
    categories: Object.keys(parsed.metadata.categories).length,
    labels: Object.keys(parsed.metadata.labels).length,
    sortKeys: Object.keys(parsed.metadata.sortKeys).length,
  }, null, 2));
}

main().catch((error) => {
  if (error instanceof IndexError) {
    console.error(JSON.stringify({ ok: false, path: error.path, reason: error.reason }, null, 2));
    process.exit(1);
  }
  throw error;
});
