import { adoptScenes } from '../withSceneLifecycle';

const SDK57_APP_DELEGATE = `class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let factory = ExpoReactNativeFactory(delegate: delegate)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}`;

describe('adoptScenes', () => {
  it('makes AppDelegate a factory provider and drops window creation', () => {
    const out = adoptScenes(SDK57_APP_DELEGATE);
    expect(out).toContain('class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
    expect(out).not.toContain('UIWindow(frame:');
    expect(out).not.toContain('startReactNative');
    expect(out).toContain('return super.application(');
  });

  it('is idempotent', () => {
    const once = adoptScenes(SDK57_APP_DELEGATE);
    expect(adoptScenes(once)).toBe(once);
  });

  it('refuses templates it does not recognise', () => {
    expect(() => adoptScenes('class AppDelegate: SomethingElse {}')).toThrow(/SDK 57 template/);
  });
});
