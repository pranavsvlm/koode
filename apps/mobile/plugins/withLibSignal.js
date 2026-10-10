/**
 * libsignal (Signal's protocol library) for end-to-end encryption.
 *
 * iOS: Signal's CocoaPod isn't on the trunk; it's installed from the tagged
 * GitHub source and downloads a prebuilt FFI archive whose SHA-256 must match
 * the checksum published with that release (no Rust toolchain needed).
 *
 * Android: Signal publishes libsignal-android to its own Maven repository
 * (added here); modules/koode-signal/android depends on it.
 *
 * Update all of these together (and @signalapp/libsignal-client for the test
 * peer) when moving to a new release.
 */
const { withAppBuildGradle, withPodfile, withProjectBuildGradle } = require('expo/config-plugins');

const VERSION = '0.103.0';
// From libsignal-client-ios-build-v0.103.0.tar.gz.sha256 on the GitHub release.
const IOS_PREBUILD_SHA256 = '3ddcc95aaa9bd8bd2b7b87a5296f1fed3a2dd28a3448ca53b56f8e0b15656535';
const MAVEN = 'https://build-artifacts.signal.org/libraries/maven/';
// libsignal-android uses java.time APIs below API 26: the app needs core library desugaring.
const DESUGAR = "coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'";

const POST_INTEGRATE = `
# libsignal (plugins/withLibSignal.js): after CocoaPods writes the xcconfigs.
post_integrate do |installer|
    installer.aggregate_targets.each do |aggregate|
      aggregate.user_build_configurations.each_key do |name|
        path = aggregate.xcconfig_path(name)
        xcconfig = File.read(path)
        next if xcconfig.include?('LIBSIGNAL_CARGO_TARGET')
        # arm64 only (Apple-silicon Simulators and devices).
        xcconfig << "\\nLIBSIGNAL_CARGO_TARGET[sdk=iphonesimulator*] = aarch64-apple-ios-sim\\n"
        xcconfig << "LIBSIGNAL_CARGO_TARGET[sdk=iphoneos*] = aarch64-apple-ios\\n"
        # The prebuilt library has no Intel-Simulator slice: Release builds
        # (all architectures) would fail to link x86_64.
        xcconfig << "EXCLUDED_ARCHS[sdk=iphonesimulator*] = x86_64\\n"
        xcconfig.sub!(/^LIBRARY_SEARCH_PATHS = (.*)$/) { "LIBRARY_SEARCH_PATHS = #{$1} \\"$(OBJROOT)/Pods.build/libsignal_ffi/target/$(LIBSIGNAL_CARGO_TARGET)/release\\"" }
        File.write(path, xcconfig)
      end
    end
end
`;

const withLibSignal = (config) => {
  config = withPodfile(config, (cfg) => {
    let podfile = cfg.modResults.contents;
    if (!podfile.includes('LIBSIGNAL_FFI_PREBUILD_CHECKSUM')) {
      podfile = `ENV['LIBSIGNAL_FFI_PREBUILD_CHECKSUM'] = '${IOS_PREBUILD_SHA256}'\n${podfile}`;
    }
    if (!podfile.includes("pod 'LibSignalClient'")) {
      podfile = podfile.replace(
        /(\n\s*use_expo_modules!\n)/,
        `$1  pod 'LibSignalClient', git: 'https://github.com/signalapp/libsignal.git', tag: 'v${VERSION}'\n`,
      );
    }
    // The pod links libsignal_ffi.a only when built as a framework; with
    // static libraries the app links it. The module map auto-links
    // -lsignal_ffi, so the app only needs the archive's directory (it's under
    // the Pods project's temp dir, per Cargo target).
    if (!podfile.includes('LIBSIGNAL_CARGO_TARGET')) podfile += POST_INTEGRATE;
    cfg.modResults.contents = podfile;
    return cfg;
  });
  config = withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (!gradle.includes('coreLibraryDesugaringEnabled')) {
      gradle = gradle.replace(
        /\nandroid \{\n/,
        '\nandroid {\n    compileOptions {\n        coreLibraryDesugaringEnabled true\n    }\n',
      );
      gradle = gradle.replace(/\ndependencies \{\n/, `\ndependencies {\n    ${DESUGAR}\n`);
    }
    cfg.modResults.contents = gradle;
    return cfg;
  });
  config = withProjectBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(MAVEN)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /allprojects\s*\{\s*repositories\s*\{/,
        (m) => `${m}\n    maven { url '${MAVEN}' }`,
      );
    }
    return cfg;
  });
  return config;
};

module.exports = withLibSignal;
module.exports.LIBSIGNAL_VERSION = VERSION;
