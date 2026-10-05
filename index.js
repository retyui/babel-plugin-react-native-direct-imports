/**
 * Rewrites named imports from `react-native` to direct `require()` calls of
 * the underlying modules, so Metro doesn't need to go through the barrel file.
 * Plain `require()` is used instead of `import` so Babel doesn't add
 * interop helpers (`_interopRequireDefault`, ...) for every module.
 *
 *   import { View, AppRegistry, Systrace } from 'react-native';
 *   // ->
 *   const View = require('react-native/Libraries/Components/View/View').default;
 *   const AppRegistry = require('react-native/Libraries/ReactNative/AppRegistry').AppRegistry;
 *   const Systrace = require('react-native/Libraries/Performance/Systrace');
 *
 * Map value format: [path, exportName], mirroring the getter in
 * `react-native/index.js`:
 *   '*'   -> `require(path)` (the getter returns the whole module)
 *   other -> `require(path).<exportName>`
 *
 * `Platform` is always required as `require('Platform')`, so Metro's
 * inline-platform optimization (Platform.OS / Platform.select) keeps working.
 *
 * Unknown names and type-only imports are left untouched.
 *
 * Options:
 *   reactNativeVersion - picks `maps/<version>.json` (defaults to the latest map)
 */

const fs = require('fs');
const nodePath = require('path');

const RN = 'react-native';

const PLATFORM = 'Platform';

const MAPS_DIR = nodePath.join(__dirname, 'maps');

const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const availableVersions = () =>
  fs
    .readdirSync(MAPS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort(compareVersions);

const loadMap = (version) => {
  const versions = availableVersions();
  const selected = version ?? versions[versions.length - 1];

  if (!versions.includes(selected)) {
    throw new Error(
      `[react-native-direct-imports] No map for react-native ${selected}. Available versions: ${versions.join(', ')}`,
    );
  }

  return require(nodePath.join(MAPS_DIR, `${selected}.json`));
};

module.exports = function reactNativeDirectImports(
  { types: t },
  { reactNativeVersion } = {},
) {
  const MAP = loadMap(reactNativeVersion);

  const buildRequire = (source, exportName, local) => {
    const call = t.callExpression(t.identifier('require'), [
      t.stringLiteral(source),
    ]);
    return t.variableDeclaration('const', [
      t.variableDeclarator(
        local,
        exportName === '*'
          ? call
          : t.memberExpression(call, t.identifier(exportName)),
      ),
    ]);
  };

  return {
    name: 'react-native-direct-imports',
    visitor: {
      ImportDeclaration(path) {
        const { node } = path;
        if (node.source.value !== RN || node.importKind === 'type') return;

        if (
          node.specifiers.some((spec) => t.isImportNamespaceSpecifier(spec))
        ) {
          throw path.buildCodeFrameError(
            "`import * as ... from 'react-native'` is not allowed, use named imports instead: `import { View } from 'react-native'`",
          );
        }

        const kept = [];
        const direct = [];

        for (const spec of node.specifiers) {
          const importedName =
            t.isImportSpecifier(spec) &&
            spec.importKind !== 'type' &&
            (t.isIdentifier(spec.imported)
              ? spec.imported.name
              : spec.imported.value);
          const local = t.identifier(spec.local.name);

          if (importedName === PLATFORM) {
            direct.push(buildRequire(PLATFORM, '*', local));
            continue;
          }

          const entry = importedName && MAP[importedName];

          if (!entry) {
            kept.push(spec);
            continue;
          }

          const [modulePath, exportName] = entry;
          direct.push(buildRequire(`${RN}/${modulePath}`, exportName, local));
        }

        if (direct.length === 0) return;

        if (kept.length > 0) {
          node.specifiers = kept;
          path.insertAfter(direct);
        } else {
          path.replaceWithMultiple(direct);
        }
      },
    },
  };
};

module.exports.loadMap = loadMap;
