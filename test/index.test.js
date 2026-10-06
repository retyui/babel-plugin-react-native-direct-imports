const { test } = require('node:test');
const assert = require('node:assert');
const babel = require('@babel/core');
const plugin = require('..');

const transform = (code) =>
  babel
    .transformSync(code, {
      plugins: [plugin],
      parserOpts: { plugins: ['typescript'] },
      babelrc: false,
      configFile: false,
    })
    .code.trim()
    .replace(/"/g, "'");

test('rewrites default, named and namespace exports', () => {
  assert.strictEqual(
    transform(
      "import { View, AppRegistry, Systrace } from 'react-native';",
    ),
    [
      "const View = require('react-native/Libraries/Components/View/View').default;",
      "const AppRegistry = require('react-native/Libraries/ReactNative/AppRegistry').AppRegistry;",
      "const Systrace = require('react-native/Libraries/Performance/Systrace');",
    ].join('\n'),
  );
});

test('keeps aliases', () => {
  assert.strictEqual(
    transform("import { Text as RNText } from 'react-native';"),
    "const RNText = require('react-native/Libraries/Text/Text').default;",
  );
});

test('leaves unknown names on the original import', () => {
  assert.strictEqual(
    transform("import { View, SomethingUnknown } from 'react-native';"),
    [
      "import { SomethingUnknown } from 'react-native';",
      "const View = require('react-native/Libraries/Components/View/View').default;",
    ].join('\n'),
  );
});

test('does not add interop helpers with the CommonJS transform', () => {
  const { code } = babel.transformSync(
    "import { View, Platform } from 'react-native';\nexport const x = [View, Platform];",
    {
      plugins: [plugin, '@babel/plugin-transform-modules-commonjs'],
      babelrc: false,
      configFile: false,
    },
  );
  assert.doesNotMatch(code, /_interopRequire/);
  assert.match(
    code,
    /const View = require\("react-native\/Libraries\/Components\/View\/View"\)\.default;/,
  );
});

test('requires Platform directly', () => {
  assert.strictEqual(
    transform("import { Platform, View } from 'react-native';"),
    [
      "const Platform = require('react-native/Libraries/Utilities/Platform').default;",
      "const View = require('react-native/Libraries/Components/View/View').default;",
    ].join('\n'),
  );
});

test('ignores other modules', () => {
  const code = "import { View } from 'react-native-web';";
  assert.strictEqual(transform(code), code);
});

test('throws on namespace import of react-native', () => {
  assert.throws(
    () => transform("import * as RN from 'react-native';"),
    /is not allowed/,
  );
});

test('uses the map for the given reactNativeVersion', () => {
  const { code } = babel.transformSync(
    "import { View } from 'react-native';",
    {
      plugins: [[plugin, { reactNativeVersion: '0.87.1' }]],
      babelrc: false,
      configFile: false,
    },
  );
  assert.match(code, /react-native\/Libraries\/Components\/View\/View/);
});

test('throws for an unknown reactNativeVersion', () => {
  assert.throws(
    () =>
      babel.transformSync("import { View } from 'react-native';", {
        plugins: [[plugin, { reactNativeVersion: '0.1.0' }]],
        babelrc: false,
        configFile: false,
      }),
    /No map for react-native 0\.1\.0\. Available versions: .*0\.87\.1/,
  );
});

test('requires CommonJS modules as a whole in older versions', () => {
  const { code } = babel.transformSync(
    "import { Image, TurboModuleRegistry } from 'react-native';",
    {
      plugins: [[plugin, { reactNativeVersion: '0.70.0' }]],
      babelrc: false,
      configFile: false,
    },
  );
  assert.match(
    code,
    /const Image = require\("react-native\/Libraries\/Image\/Image"\);/,
  );
  assert.match(
    code,
    /const TurboModuleRegistry = require\("react-native\/Libraries\/TurboModule\/TurboModuleRegistry"\);/,
  );
});

test('rewrites re-exports', () => {
  assert.strictEqual(
    transform(
      "export { findNodeHandle, View as RNView } from 'react-native';",
    ),
    [
      "const _findNodeHandle = require('react-native/Libraries/ReactNative/RendererProxy').findNodeHandle;",
      "const _View = require('react-native/Libraries/Components/View/View').default;",
      'export { _findNodeHandle as findNodeHandle, _View as RNView };',
    ].join('\n'),
  );
});

test('leaves unknown and type-only re-exports on the original export', () => {
  assert.strictEqual(
    transform(
      "export { View, SomethingUnknown } from 'react-native';\nexport type { ViewProps } from 'react-native';",
    ),
    [
      "export { SomethingUnknown } from 'react-native';",
      "const _View = require('react-native/Libraries/Components/View/View').default;",
      'export { _View as View };',
      "export type { ViewProps } from 'react-native';",
    ].join('\n'),
  );
});

test('re-exports work with the CommonJS transform', () => {
  const { code } = babel.transformSync(
    "export { findNodeHandle } from 'react-native';",
    {
      plugins: [plugin, '@babel/plugin-transform-modules-commonjs'],
      babelrc: false,
      configFile: false,
    },
  );
  assert.doesNotMatch(code, /require\("react-native"\)/);
  assert.match(
    code,
    /exports\.findNodeHandle = require\("react-native\/Libraries\/ReactNative\/RendererProxy"\)\.findNodeHandle;/,
  );
});

test('inlines unstable_batchedUpdates when it has no module', () => {
  assert.strictEqual(
    transform("import { unstable_batchedUpdates } from 'react-native';"),
    'const unstable_batchedUpdates = (fn, bookkeeping) => fn(bookkeeping);',
  );
});

test('warns once about unstable_batchedUpdates on 0.86+', (t) => {
  // fresh copy, so the once-per-process flag is reset
  delete require.cache[require.resolve('..')];
  const freshPlugin = require('..');
  const warn = t.mock.method(console, 'warn', () => {});
  const run = (options) =>
    babel.transformSync(
      "import { unstable_batchedUpdates } from 'react-native';",
      { plugins: [[freshPlugin, options]], babelrc: false, configFile: false },
    );

  run({ silenceBatchedUpdatesWarning: true });
  run({ reactNativeVersion: '0.85.3' });
  assert.strictEqual(warn.mock.callCount(), 0);

  run({});
  run({});
  assert.strictEqual(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /unstable_batchedUpdates/);
});

test('requires unstable_batchedUpdates in versions that have a getter', () => {
  const { code } = babel.transformSync(
    "import { unstable_batchedUpdates } from 'react-native';",
    {
      plugins: [[plugin, { reactNativeVersion: '0.85.3' }]],
      babelrc: false,
      configFile: false,
    },
  );
  assert.match(
    code,
    /const unstable_batchedUpdates = require\("react-native\/Libraries\/ReactNative\/RendererProxy"\)\.unstable_batchedUpdates;/,
  );
});

test('rewrites member access on a require() binding', () => {
  assert.strictEqual(
    transform(
      [
        "var react_native_1 = require('react-native');",
        'react_native_1.Alert.alert("Test");',
        'const runCommand = `npx expo run:${react_native_1.Platform.OS}`;',
        'var bridge = react_native_1.NativeModules.ReactNativeBiometrics;',
        'var IS_WEB = !react_native_1.Platform || react_native_1.Platform.OS === "web";',
        "react_native_1.requireNativeComponent('RNHoleView');",
        'new react_native_1.NativeEventEmitter(emitterModule);',
        '(0, react_native_1.View);',
      ].join('\n'),
    ),
    [
      "var Platform = require('react-native/Libraries/Utilities/Platform').default;",
      "require('react-native/Libraries/Alert/Alert').default.alert('Test');",
      'const runCommand = `npx expo run:${Platform.OS}`;',
      "var bridge = require('react-native/Libraries/BatchedBridge/NativeModules').default.ReactNativeBiometrics;",
      "var IS_WEB = !Platform || Platform.OS === 'web';",
      "require('react-native/Libraries/ReactNative/requireNativeComponent').default('RNHoleView');",
      "new (require('react-native/Libraries/EventEmitter/NativeEventEmitter').default)(emitterModule);",
      "0, require('react-native/Libraries/Components/View/View').default;",
    ].join('\n'),
  );
});

test('keeps the require() binding when some usages cannot be rewritten', () => {
  assert.strictEqual(
    transform(
      [
        "const _reactNative = require('react-native');",
        '_reactNative.View;',
        '_reactNative.SomethingUnknown;',
        'foo(_reactNative);',
      ].join('\n'),
    ),
    [
      "const _reactNative = require('react-native');",
      "require('react-native/Libraries/Components/View/View').default;",
      '_reactNative.SomethingUnknown;',
      'foo(_reactNative);',
    ].join('\n'),
  );
});

test('rewrites two require() bindings of react-native', () => {
  assert.strictEqual(
    transform(
      [
        "var react_native_1 = require('react-native');",
        "var react_native_2 = require('react-native');",
        'react_native_1.NativeModules.RNPurchases;',
        "if (react_native_2.Platform.OS === 'ios') {}",
      ].join('\n'),
    ),
    [
      "var Platform = require('react-native/Libraries/Utilities/Platform').default;",
      "require('react-native/Libraries/BatchedBridge/NativeModules').default.RNPurchases;",
      "if (Platform.OS === 'ios') {}",
    ].join('\n'),
  );
});

test('rewrites destructured require()', () => {
  assert.strictEqual(
    transform(
      [
        "const { TurboModuleRegistry, Text: RNText } = require('react-native');",
        "const { AssetRegistry } = require('react-native');",
        "const { DrawerLayoutAndroid } = require('react-native') as { DrawerLayoutAndroid: any };",
      ].join('\n'),
    ),
    [
      "const TurboModuleRegistry = require('react-native/Libraries/TurboModule/TurboModuleRegistry'),",
      "  RNText = require('react-native/Libraries/Text/Text').default;",
      "const AssetRegistry = require('react-native/src/private/assets/AssetRegistry').AssetRegistry;",
      "const DrawerLayoutAndroid = require('react-native/Libraries/Components/DrawerAndroid/DrawerLayoutAndroid').default;",
    ].join('\n'),
  );
});

test('leaves unknown destructured names on the original require()', () => {
  assert.strictEqual(
    transform(
      "const { View, SomethingUnknown, ...rest } = require('react-native');",
    ),
    [
      "const {",
      '    SomethingUnknown,',
      '    ...rest',
      "  } = require('react-native'),",
      "  View = require('react-native/Libraries/Components/View/View').default;",
    ].join('\n'),
  );
});

test('rewrites inline require() member access', () => {
  assert.strictEqual(
    transform(
      "(_a = require('react-native').Linking) !== null && _a !== void 0 ? _a : null;",
    ),
    "(_a = require('react-native/Libraries/Linking/Linking').default) !== null && _a !== void 0 ? _a : null;",
  );
});

test('ignores a shadowed require', () => {
  const code = "function f(require) {\n  return require('react-native').View;\n}";
  assert.strictEqual(transform(code), code);
});

test('throws on module.exports = require("react-native")', () => {
  assert.throws(
    () => transform("module.exports = require('react-native');"),
    /is not allowed/,
  );
});

test('points inline require() Platform usages at a shared Platform variable', () => {
  assert.strictEqual(
    transform("const os = require('react-native').Platform.OS;"),
    [
      "var Platform = require('react-native/Libraries/Utilities/Platform').default;",
      'const os = Platform.OS;',
    ].join('\n'),
  );
});

test('inlines the Platform require() when Platform is already taken', () => {
  assert.strictEqual(
    transform(
      [
        "const Platform = 'web';",
        "const x = require('react-native');",
        'x.Platform.OS;',
      ].join('\n'),
    ),
    [
      "const Platform = 'web';",
      "require('react-native/Libraries/Utilities/Platform').default.OS;",
    ].join('\n'),
  );
});

test('works with other plugins visiting the same require() call', () => {
  // Mimics @nkzw/babel-plugin-fbtee, which reads `path.parentPath.parent.type`
  const other = () => ({
    visitor: {
      CallExpression(path) {
        path.parentPath.parent.type;
      },
    },
  });
  const { code } = babel.transformSync(
    [
      "const { TurboModuleRegistry } = require('react-native');",
      "const x = require('react-native');",
      'x.View;',
      "require('react-native').Linking;",
    ].join('\n'),
    { plugins: [plugin, other], babelrc: false, configFile: false },
  );
  assert.doesNotMatch(code, /require\("react-native"\)/);
});
