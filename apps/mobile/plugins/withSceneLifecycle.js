/**
 * Adopt the UIScene life cycle on Expo SDK 57.
 *
 * iOS 27 terminates apps built with the iOS 27 SDK that don't use scenes
 * (expo/expo#46663). Expo SDK 58 fixes this in its template (expo/expo#46733)
 * using `ExpoAppSceneDelegate`, which SDK 57 already ships. This plugin applies
 * the same change to the SDK 57 template:
 *
 *   1. Info.plist registers ExpoAppSceneDelegate as the window scene delegate.
 *   2. AppDelegate conforms to ExpoReactNativeFactoryProvider and no longer
 *      creates the window itself; the scene delegate starts React Native.
 *
 * Remove this plugin when upgrading to Expo SDK 58.
 */
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_DELEGATE = 'EXExpoAppSceneDelegate'; // @objc name of ExpoAppSceneDelegate

const WINDOW_BLOCK =
  /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif\n/;
const CLASS_DECL = 'class AppDelegate: ExpoAppDelegate {';

function adoptScenes(contents) {
  if (contents.includes('ExpoReactNativeFactoryProvider')) return contents; // already adopted
  if (!contents.includes(CLASS_DECL) || !WINDOW_BLOCK.test(contents)) {
    throw new Error(
      '[withSceneLifecycle] AppDelegate.swift does not match the Expo SDK 57 template. ' +
        'If you upgraded to SDK 58+, remove this plugin; otherwise update its patterns.',
    );
  }
  return contents
    .replace(CLASS_DECL, 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {')
    .replace(
      WINDOW_BLOCK,
      '    // The window is created and React Native started by ExpoAppSceneDelegate\n' +
        '    // (scene life cycle, required on iOS 27). See plugins/withSceneLifecycle.js.\n',
    );
}

const withSceneLifecycle = (config) => {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: SCENE_DELEGATE,
          },
        ],
      },
    };
    return c;
  });
  return withAppDelegate(config, (c) => {
    if (c.modResults.language !== 'swift') {
      throw new Error('[withSceneLifecycle] Only Swift AppDelegates are supported.');
    }
    c.modResults.contents = adoptScenes(c.modResults.contents);
    return c;
  });
};

module.exports = withSceneLifecycle;
module.exports.adoptScenes = adoptScenes;
