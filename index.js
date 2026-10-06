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
 * Re-exports are rewritten the same way:
 *
 *   export { findNodeHandle } from 'react-native';
 *   // ->
 *   const _findNodeHandle = require('react-native/Libraries/ReactNative/RendererProxy').findNodeHandle;
 *   export { _findNodeHandle as findNodeHandle };
 *
 * `require('react-native')` in compiled CommonJS code is rewritten too. Each
 * usage gets its own inline `require()`, keeping the barrel's lazy getters:
 *
 *   var react_native_1 = require('react-native');
 *   react_native_1.Alert.alert('Hi');
 *   const { View } = require('react-native');
 *   // ->
 *   require('react-native/Libraries/Alert/Alert').default.alert('Hi');
 *   const View = require('react-native/Libraries/Components/View/View').default;
 *
 * The `require('react-native')` binding is removed only when every usage was
 * rewritten (`x.Unknown`, `foo(x)`, ... keep it).
 *
 * Unknown names and type-only imports/exports are left untouched.
 *
 * Options:
 *   reactNativeVersion - picks `maps/<version>.json` (defaults to the latest map)
 *   silenceBatchedUpdatesWarning - hides the `unstable_batchedUpdates` no-op
 *     warning on 0.86+
 */

const fs = require('fs');
const nodePath = require('path');

const RN = 'react-native';

const MAPS_DIR = nodePath.join(__dirname, 'maps');

let warnedBatchedUpdates = false;

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
  { reactNativeVersion, silenceBatchedUpdatesWarning = false } = {},
) {
  const MAP = loadMap(reactNativeVersion);

  const buildRequire = (source, exportName) => {
    const call = t.callExpression(t.identifier('require'), [
      t.stringLiteral(source),
    ]);
    return exportName === '*'
      ? call
      : t.memberExpression(call, t.identifier(exportName));
  };

  const nameOf = (node) => (t.isIdentifier(node) ? node.name : node.value);

  // Since 0.86 `unstable_batchedUpdates` is a plain method in
  // `react-native/index.js` (no getter, no module to require), so it gets
  // inlined: `(fn, bookkeeping) => fn(bookkeeping)`.
  const buildBatchedUpdates = () => {
    if (!silenceBatchedUpdatesWarning && !warnedBatchedUpdates) {
      warnedBatchedUpdates = true;
      console.warn(
        '[react-native-direct-imports] `unstable_batchedUpdates` does nothing since react-native 0.86, it just calls the callback: https://github.com/react/react-native/commit/1a623a826654db4238cddc22fb958ccb76207a74. Pass `silenceBatchedUpdatesWarning: true` to hide this warning.',
      );
    }
    const fn = t.identifier('fn');
    const bookkeeping = t.identifier('bookkeeping');
    return t.arrowFunctionExpression(
      [fn, bookkeeping],
      t.callExpression(fn, [bookkeeping]),
    );
  };

  // Returns the direct `require()` expression for a name from
  // `react-native`, or `null` if the name is not in the map.
  const buildDirectExpression = (importedName) => {
    const entry = MAP[importedName];
    if (!entry && importedName === 'unstable_batchedUpdates') {
      return buildBatchedUpdates();
    }
    if (!entry) return null;
    const [modulePath, exportName] = entry;
    return buildRequire(`${RN}/${modulePath}`, exportName);
  };

  // Returns the `require()` declaration for a name from `react-native`, or
  // `null` if the name is not in the map.
  const buildDirect = (importedName, local) => {
    const expression = buildDirectExpression(importedName);
    return (
      expression &&
      t.variableDeclaration('const', [t.variableDeclarator(local, expression)])
    );
  };

  // `x.View` / `x['View']` -> 'View', anything else -> null
  const memberName = (node) => {
    if (!t.isMemberExpression(node)) return null;
    if (!node.computed && t.isIdentifier(node.property)) {
      return node.property.name;
    }
    if (node.computed && t.isStringLiteral(node.property)) {
      return node.property.value;
    }
    return null;
  };

  // `require('react-native')`, also wrapped in `(... as T)`, `(...)!`, `(...)`.
  const isRequireOfReactNative = (node, scope) => {
    while (
      t.isTSAsExpression(node) ||
      t.isTSSatisfiesExpression(node) ||
      t.isTSNonNullExpression(node) ||
      t.isTSTypeAssertion(node) ||
      t.isTypeCastExpression(node) ||
      t.isParenthesizedExpression(node)
    ) {
      node = node.expression;
    }
    return (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee, { name: 'require' }) &&
      !scope.hasBinding('require') &&
      node.arguments.length === 1 &&
      t.isStringLiteral(node.arguments[0], { value: RN })
    );
  };

  // Metro's `inlinePlatform` only inlines `Platform.OS` / `Platform.select`
  // on an identifier named `Platform`, so `x.Platform` is pointed at a single
  // `var Platform = require(...)` added at the top of the file. Returns `null`
  // if `Platform` is already taken at the usage site.
  const platformIdentifier = (memberPath, state) => {
    const binding = memberPath.scope.getBinding('Platform');

    if (state.platformDeclarator) {
      return binding?.path.node === state.platformDeclarator
        ? t.identifier('Platform')
        : null;
    }

    const program = memberPath.scope.getProgramParent();
    if (binding || program.hasGlobal('Platform')) return null;

    const declarator = t.variableDeclarator(
      t.identifier('Platform'),
      buildDirectExpression('Platform'),
    );
    const [declarationPath] = program.path.unshiftContainer(
      'body',
      t.variableDeclaration('var', [declarator]),
    );
    program.registerDeclaration(declarationPath);
    state.platformDeclarator = declarator;

    return t.identifier('Platform');
  };

  // Replaces `x.View` with the direct `require()` expression. Returns `false`
  // if the member can't be rewritten.
  const replaceMember = (memberPath, state) => {
    const { parentPath } = memberPath;
    if (
      (parentPath.isAssignmentExpression() &&
        parentPath.node.left === memberPath.node) ||
      parentPath.isUpdateExpression() ||
      parentPath.isUnaryExpression({ operator: 'delete' })
    ) {
      return false;
    }

    const name = memberName(memberPath.node);
    const expression =
      (name === 'Platform' &&
        MAP.Platform &&
        platformIdentifier(memberPath, state)) ||
      buildDirectExpression(name);
    if (!expression) return false;

    memberPath.replaceWith(expression);
    return true;
  };

  // var x = require('react-native');
  // x.View; x.Platform.OS;
  const rewriteBinding = (declaratorPath, state) => {
    const { name } = declaratorPath.node.id;
    const binding = declaratorPath.scope.getBinding(name);
    if (!binding || binding.path !== declaratorPath || !binding.constant) {
      return;
    }

    let rewroteAll = true;
    for (const ref of binding.referencePaths) {
      const memberPath = ref.parentPath;
      const rewritten =
        memberPath.isMemberExpression() &&
        memberPath.node.object === ref.node &&
        replaceMember(memberPath, state);
      if (!rewritten) rewroteAll = false;
    }

    if (rewroteAll) declaratorPath.remove();
  };

  // const { View, Text: RNText } = require('react-native');
  const rewritePattern = (declaratorPath) => {
    const { node } = declaratorPath;
    const kept = [];
    const direct = [];

    for (const prop of node.id.properties) {
      const expression =
        t.isObjectProperty(prop) &&
        !prop.computed &&
        t.isIdentifier(prop.value) &&
        buildDirectExpression(nameOf(prop.key));

      if (!expression) {
        kept.push(prop);
        continue;
      }

      direct.push(t.variableDeclarator(prop.value, expression));
    }

    if (direct.length === 0) return;

    if (kept.length > 0) {
      node.id.properties = kept;
      declaratorPath.insertAfter(direct);
    } else {
      declaratorPath.replaceWithMultiple(direct);
    }
  };

  return {
    name: 'react-native-direct-imports',
    visitor: {
      // Rewrites happen on the replaced node itself (not from the inner
      // `require()` call), so other plugins visiting the same nodes don't
      // see detached paths.
      AssignmentExpression(path) {
        const { node } = path;
        if (
          path.get('left').matchesPattern('module.exports') &&
          isRequireOfReactNative(node.right, path.scope)
        ) {
          throw path.buildCodeFrameError(
            "`module.exports = require('react-native')` is not allowed, re-export named values instead: `exports.View = require('react-native').View`",
          );
        }
      },

      // require('react-native').Linking
      MemberExpression(path, state) {
        if (isRequireOfReactNative(path.node.object, path.scope)) {
          replaceMember(path, state);
        }
      },

      VariableDeclarator(path, state) {
        const { node } = path;
        if (!isRequireOfReactNative(node.init, path.scope)) return;

        if (t.isIdentifier(node.id)) {
          rewriteBinding(path, state);
        } else if (t.isObjectPattern(node.id)) {
          rewritePattern(path);
        }
      },

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
          const declaration =
            t.isImportSpecifier(spec) &&
            spec.importKind !== 'type' &&
            buildDirect(nameOf(spec.imported), t.identifier(spec.local.name));

          if (!declaration) {
            kept.push(spec);
            continue;
          }

          direct.push(declaration);
        }

        if (direct.length === 0) return;

        if (kept.length > 0) {
          node.specifiers = kept;
          path.insertAfter(direct);
        } else {
          path.replaceWithMultiple(direct);
        }
      },

      ExportNamedDeclaration(path) {
        const { node } = path;
        if (node.source?.value !== RN || node.exportKind === 'type') return;

        const kept = [];
        const direct = [];
        const reexported = [];

        for (const spec of node.specifiers) {
          if (!t.isExportSpecifier(spec) || spec.exportKind === 'type') {
            kept.push(spec);
            continue;
          }

          const importedName = nameOf(spec.local);
          const local = path.scope.generateUidIdentifier(importedName);
          const declaration = buildDirect(importedName, local);

          if (!declaration) {
            kept.push(spec);
            continue;
          }

          direct.push(declaration);
          reexported.push(
            t.exportSpecifier(t.identifier(local.name), spec.exported),
          );
        }

        if (direct.length === 0) return;

        const replacement = [
          ...direct,
          t.exportNamedDeclaration(null, reexported),
        ];

        if (kept.length > 0) {
          node.specifiers = kept;
          path.insertAfter(replacement);
        } else {
          path.replaceWithMultiple(replacement);
        }
      },
    },
  };
};

module.exports.loadMap = loadMap;
