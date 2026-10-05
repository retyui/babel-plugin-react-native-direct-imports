const { test } = require('node:test');
const assert = require('node:assert');
const babel = require('@babel/core');
const plugin = require('..');

const transform = (code) =>
  babel
    .transformSync(code, {
      plugins: [plugin],
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
      "import View from 'react-native/Libraries/Components/View/View';",
      "import { AppRegistry } from 'react-native/Libraries/ReactNative/AppRegistry';",
      "import * as Systrace from 'react-native/Libraries/Performance/Systrace';",
    ].join('\n'),
  );
});

test('keeps aliases', () => {
  assert.strictEqual(
    transform("import { Text as RNText } from 'react-native';"),
    "import RNText from 'react-native/Libraries/Text/Text';",
  );
});

test('leaves unknown names on the original import', () => {
  assert.strictEqual(
    transform("import { View, SomethingUnknown } from 'react-native';"),
    [
      "import { SomethingUnknown } from 'react-native';",
      "import View from 'react-native/Libraries/Components/View/View';",
    ].join('\n'),
  );
});

test('keeps Platform on the react-native import', () => {
  assert.strictEqual(
    transform("import { View, Platform } from 'react-native';"),
    [
      "import { Platform } from 'react-native';",
      "import View from 'react-native/Libraries/Components/View/View';",
    ].join('\n'),
  );
  const code = "import { Platform } from 'react-native';";
  assert.strictEqual(transform(code), code);
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

test('uses default import for CommonJS modules in older versions', () => {
  const { code } = babel.transformSync(
    "import { Image, TurboModuleRegistry } from 'react-native';",
    {
      plugins: [[plugin, { reactNativeVersion: '0.70.0' }]],
      babelrc: false,
      configFile: false,
    },
  );
  assert.match(code, /import Image from "react-native\/Libraries\/Image\/Image"/);
  assert.match(
    code,
    /import \* as TurboModuleRegistry from "react-native\/Libraries\/TurboModule\/TurboModuleRegistry"/,
  );
});
