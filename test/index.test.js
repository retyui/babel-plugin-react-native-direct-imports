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
