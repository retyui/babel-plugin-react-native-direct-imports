#!/usr/bin/env node
/**
 * Dev-only: generates `maps/<version>.json` for every stable react-native
 * release starting from 0.70.0 (no nightlies, no prereleases, no 1000.0.0).
 *
 * For each version it fetches `react-native/index.js` from jsDelivr, parses the
 * lazy getters and turns them into map entries:
 *
 *   get Image() { return require('./Libraries/Image/Image').default; }
 *   // -> Image: ['Libraries/Image/Image', 'default']
 *
 *   get AppRegistry() { return require('./Libraries/ReactNative/AppRegistry').AppRegistry; }
 *   // -> AppRegistry: ['Libraries/ReactNative/AppRegistry', 'AppRegistry']
 *
 * When the whole module is returned (`require('./X')` with no property),
 * the target file is fetched to see how it exports:
 *   - CommonJS (`module.exports = Image`) -> 'default'
 *     (babel import interop turns a default import into `module.exports`)
 *   - ESM (`export function ...`)         -> '*'
 *
 * Getters that don't end with `return require(...)` (removed APIs that throw,
 * no-op shims) are skipped.
 *
 * Usage:
 *   node scripts/generate-maps.js            # all versions
 *   node scripts/generate-maps.js 0.87.1     # selected versions
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('hermes-parser');

const MIN_MINOR = 70;
const CONCURRENCY = 4;
const MAPS_DIR = path.join(__dirname, '..', 'maps');
const CDN = 'https://cdn.jsdelivr.net/npm/react-native';
const DATA_API = 'https://data.jsdelivr.com/v1/packages/npm/react-native';
const EXTENSIONS = ['.js', '.ios.js', '.android.js', '.native.js', '/index.js'];

const MAX_REQUESTS = 24;
let activeRequests = 0;
const queue = [];

const limited = async (fn) => {
  if (activeRequests >= MAX_REQUESTS) {
    await new Promise((resolve) => queue.push(resolve));
  }
  activeRequests++;
  try {
    return await fn();
  } finally {
    activeRequests--;
    queue.shift()?.();
  }
};

const fetchText = async (url, attempt = 1) => {
  const res = await limited(() => fetch(url));
  if (res.ok) return limited(() => res.text());
  if (attempt < 4 && res.status >= 500) {
    await new Promise((r) => setTimeout(r, attempt * 1000));
    return fetchText(url, attempt + 1);
  }
  throw new Error(`GET ${url} -> ${res.status}`);
};

const fetchJson = async (url) => JSON.parse(await fetchText(url));

const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
};

const parseFlow = (code) =>
  parse(code, { flow: 'all', sourceType: 'module', babel: false });

const getStableVersions = async () => {
  const { versions } = await fetchJson('https://registry.npmjs.org/react-native');
  return Object.keys(versions)
    .filter((v) => /^0\.\d+\.\d+$/.test(v) && Number(v.split('.')[1]) >= MIN_MINOR)
    .sort((a, b) => {
      const [, am, ap] = a.split('.').map(Number);
      const [, bm, bp] = b.split('.').map(Number);
      return am - bm || ap - bp;
    });
};

// `require('./X')` / `require('./X').prop` -> { source, prop }
const readRequire = (node) => {
  let prop = null;
  if (node.type === 'MemberExpression' && !node.computed) {
    prop = node.property.name;
    node = node.object;
  }
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    node.arguments.length === 1 &&
    node.arguments[0].type === 'Literal' &&
    typeof node.arguments[0].value === 'string'
  ) {
    return { source: node.arguments[0].value, prop };
  }
  return null;
};

// Getter body must end with `return require(...)`; preceding statements
// (e.g. `warnOnce(...)` deprecation notices) are allowed.
const readGetter = (fn) => {
  const body = fn.body.body;
  const last = body[body.length - 1];
  if (!last || last.type !== 'ReturnStatement' || !last.argument) return null;
  return readRequire(last.argument);
};

const unwrapCast = (node) =>
  node.type === 'TypeCastExpression' || node.type === 'AsExpression'
    ? unwrapCast(node.expression)
    : node;

const isModuleExports = (node) =>
  node.type === 'MemberExpression' &&
  node.object.type === 'Identifier' &&
  node.object.name === 'module' &&
  node.property.type === 'Identifier' &&
  node.property.name === 'exports';

const keyName = (key) => (key.type === 'Identifier' ? key.name : key.value);

// Returns [[exportName, { source, prop }], ...] in source order.
const extractGetters = (code) => {
  const ast = parseFlow(code);
  const entries = [];

  for (const statement of ast.body) {
    if (statement.type !== 'ExpressionStatement') continue;
    const expr = statement.expression;

    // module.exports = { get View() { ... }, ... }
    if (
      expr.type === 'AssignmentExpression' &&
      isModuleExports(expr.left)
    ) {
      const obj = unwrapCast(expr.right);
      if (obj.type !== 'ObjectExpression') continue;
      for (const prop of obj.properties) {
        if (prop.type !== 'Property' || prop.kind !== 'get') continue;
        const req = readGetter(prop.value);
        if (req) entries.push([keyName(prop.key), req]);
      }
    }

    // Object.defineProperty(module.exports, 'Touchable', { get() { ... } })
    if (
      expr.type === 'CallExpression' &&
      expr.callee.type === 'MemberExpression' &&
      expr.callee.object.name === 'Object' &&
      expr.callee.property.name === 'defineProperty' &&
      isModuleExports(expr.arguments[0]) &&
      expr.arguments[1]?.type === 'Literal' &&
      expr.arguments[2]?.type === 'ObjectExpression'
    ) {
      const getter = expr.arguments[2].properties.find(
        (p) => p.type === 'Property' && keyName(p.key) === 'get',
      );
      const req = getter && readGetter(getter.value);
      if (req) entries.push([expr.arguments[1].value, req]);
    }
  }

  return entries;
};

// 'esm' | 'cjs' | null
const detectModuleType = (code) => {
  const ast = parseFlow(code);
  let cjs = false;
  for (const statement of ast.body) {
    if (
      (statement.type === 'ExportNamedDeclaration' &&
        statement.exportKind !== 'type') ||
      statement.type === 'ExportDefaultDeclaration' ||
      (statement.type === 'ExportAllDeclaration' &&
        statement.exportKind !== 'type')
    ) {
      return 'esm';
    }
    if (
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'AssignmentExpression' &&
      (isModuleExports(statement.expression.left) ||
        (statement.expression.left.type === 'MemberExpression' &&
          (isModuleExports(statement.expression.left.object) ||
            statement.expression.left.object.name === 'exports')))
    ) {
      cjs = true;
    }
  }
  return cjs ? 'cjs' : null;
};

// Module type cache shared across versions, keyed by file content hash.
const moduleTypeByHash = new Map();

const getModuleType = (version, file) => {
  if (!moduleTypeByHash.has(file.hash)) {
    moduleTypeByHash.set(
      file.hash,
      fetchText(`${CDN}@${version}${file.name}`).then(detectModuleType),
    );
  }
  return moduleTypeByHash.get(file.hash);
};

const generateMap = async (version) => {
  const [indexCode, listing] = await Promise.all([
    fetchText(`${CDN}@${version}/index.js`),
    fetchJson(`${DATA_API}@${version}?structure=flat`),
  ]);
  const files = new Map(listing.files.map((f) => [f.name, f]));
  const warnings = [];

  const entries = await Promise.all(
    extractGetters(indexCode).map(async ([name, { source, prop }]) => {
      const modulePath = path.posix.normalize(source).replace(/^\.\//, '');
      if (prop) return [name, [modulePath, prop]];

      const candidates = EXTENSIONS.map((ext) =>
        files.get(`/${modulePath}${ext}`),
      ).filter(Boolean);
      if (candidates.length === 0) {
        warnings.push(`${name}: cannot resolve ${source}`);
        return null;
      }

      const types = new Set(
        await Promise.all(candidates.map((f) => getModuleType(version, f))),
      );
      if (types.size !== 1 || types.has(null)) {
        warnings.push(
          `${name}: unknown module type of ${source} (${[...types]})`,
        );
        return null;
      }

      return [name, [modulePath, types.has('esm') ? '*' : 'default']];
    }),
  );

  const map = Object.fromEntries(entries.filter(Boolean));
  return { map, warnings };
};

const main = async () => {
  const requested = process.argv.slice(2);
  const versions = requested.length > 0 ? requested : await getStableVersions();

  fs.mkdirSync(MAPS_DIR, { recursive: true });
  console.log(`Generating maps for ${versions.length} react-native versions`);

  let failed = 0;
  await mapLimit(versions, CONCURRENCY, async (version) => {
    try {
      const { map, warnings } = await generateMap(version);
      fs.writeFileSync(
        path.join(MAPS_DIR, `${version}.json`),
        JSON.stringify(map, null, 2) + '\n',
      );
      console.log(`✔ ${version} (${Object.keys(map).length} entries)`);
      for (const w of warnings) console.warn(`  ⚠ ${version} ${w}`);
    } catch (error) {
      failed++;
      console.error(`✖ ${version}: ${error.message}`);
    }
  });

  if (failed > 0) process.exitCode = 1;
};

main();
