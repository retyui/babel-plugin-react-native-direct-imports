/**
 * Rewrites named imports from `react-native` to direct imports of the
 * underlying modules, so Metro doesn't need to go through the barrel file.
 *
 *   import { View, AppRegistry, Systrace } from 'react-native';
 *   // ->
 *   import View from 'react-native/Libraries/Components/View/View';
 *   import { AppRegistry } from 'react-native/Libraries/ReactNative/AppRegistry';
 *   import * as Systrace from 'react-native/Libraries/Performance/Systrace';
 *
 * Map value format: [path, exportName]
 *   'default' -> default import
 *   '*'       -> namespace import (module is used as a whole, no `.default`)
 *   other     -> named import
 *
 * Unknown names and type-only imports are left untouched.
 *
 * Options:
 *   reactNativeVersion - picks `maps/<version>.json` (defaults to the latest map)
 */

const fs = require('fs');
const nodePath = require('path');

const RN = 'react-native';

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

  const buildSpecifier = (exportName, local) => {
    if (exportName === 'default') return t.importDefaultSpecifier(local);
    if (exportName === '*') return t.importNamespaceSpecifier(local);
    return t.importSpecifier(local, t.identifier(exportName));
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
          const entry =
            t.isImportSpecifier(spec) &&
            spec.importKind !== 'type' &&
            MAP[
              t.isIdentifier(spec.imported)
                ? spec.imported.name
                : spec.imported.value
            ];

          if (!entry) {
            kept.push(spec);
            continue;
          }

          const [modulePath, exportName] = entry;
          direct.push(
            t.importDeclaration(
              [buildSpecifier(exportName, t.identifier(spec.local.name))],
              t.stringLiteral(`${RN}/${modulePath}`),
            ),
          );
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
