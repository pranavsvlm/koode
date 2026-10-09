Pod::Spec.new do |s|
  s.name           = 'KoodeSignal'
  s.version        = '0.1.0'
  s.summary        = 'End-to-end encryption for Koode using libsignal.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Koode'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Installed from Signal's repository by plugins/withLibSignal.js.
  s.dependency 'LibSignalClient'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
