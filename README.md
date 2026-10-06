# babel-plugin-react-native-direct-imports

[![npm version](https://badgen.net/npm/v/babel-plugin-react-native-direct-imports)](https://www.npmjs.com/package/babel-plugin-react-native-direct-imports)
[![npm downloads](https://badgen.net/npm/dm/babel-plugin-react-native-direct-imports)](https://www.npmtrends.com/babel-plugin-react-native-direct-imports)
[![license](https://badgen.net/npm/license/babel-plugin-react-native-direct-imports)](https://www.npmjs.com/package/babel-plugin-react-native-direct-imports)

Babel plugin that replaces `react-native` imports with direct requires of the underlying modules, so only what you use ends up in the bundle.

```js
import { View, AppRegistry, Systrace } from 'react-native';

// ↓ becomes

const View = require('react-native/Libraries/Components/View/View').default;
const AppRegistry = require('react-native/Libraries/ReactNative/AppRegistry').AppRegistry;
const Systrace = require('react-native/Libraries/Performance/Systrace');
```

## Why

`react-native/index.js` is a CommonJS barrel with a lazy `require()` getter for every public API. Bundlers can't tree-shake it, so a single `import { View } from 'react-native'` pulls in all of React Native (`VirtualView`, `PushNotificationIOS`, ...).

Bundle with only `import { ReactNativeVersion } from 'react-native'`, before and after:

![Bundle before and after the plugin](./assets/before-after.png)

### Why `require()` and not `import`?

React Native's modules are CommonJS. If the plugin emitted `import View from '...'`, Babel's CommonJS transform would wrap every one in `_interopRequireDefault()` / `_interopRequireWildcard()` and add those helpers to each file. A plain `require(...).default` gives the same value without the extra code.

## Install

```bash
npm install --save-dev babel-plugin-react-native-direct-imports
```

## Usage

```js
// babel.config.js
module.exports = {
  presets: [
    // the plugin generates deep imports on purpose
    ['module:@react-native/babel-preset', { disableDeepImportWarnings: true }],
  ],
  plugins: [
    process.env.NODE_ENV !== 'test' && [
      'react-native-direct-imports',
      { reactNativeVersion: require('react-native/package.json').version },
    ],
  ].filter(Boolean),
};
```

Then reset the Metro cache once (`npx react-native start --reset-cache` or `npx expo start --clear`).

`reactNativeVersion` picks the map from [`maps/`](maps) (default: the latest). Every stable release from `0.70.0` has one. The version must match exactly, otherwise the build fails, so update the plugin after upgrading React Native.

`silenceBatchedUpdatesWarning` (default: `false`) hides the warning logged once when `unstable_batchedUpdates` is imported on React Native 0.86+, where it [does nothing](https://github.com/react/react-native/commit/1a623a826654db4238cddc22fb958ccb76207a74) and just calls the callback.

## Notes

- Unknown names and type-only imports are left untouched.
- Re-exports (`export { X } from 'react-native'`) and `require('react-native')` in compiled CommonJS code (e.g. in `node_modules`) are rewritten too.
- `Platform` stays a local `Platform` variable, so Metro's `Platform.OS` / `Platform.select` inlining keeps working (not for aliases like `Platform as P`).
- `import * as RN from 'react-native'` and `module.exports = require('react-native')` throw a build error.
- Generated paths point to React Native internals, which is why every version has its own map.

## Compatibility

- ✅ [Uniwind](https://github.com/uni-stack/uniwind): `withUniwindConfig` also redirects deep `react-native/Libraries/...` imports of the components it styles, so `className` keeps working.
- ❌ `react-native-worklets` bundle mode: `getBundleModeMetroConfig` resolves `react-native` to its own [shim](https://github.com/software-mansion/react-native-reanimated/blob/main/packages/react-native-worklets/bundleMode/shims/reactNativeShim.js), which sets up the worklet runtime. The deep paths skip it, so don't combine them.

## Generating maps (development)

```bash
yarn generate-maps            # all versions
yarn generate-maps 0.87.1     # specific versions
```

## License

MIT
