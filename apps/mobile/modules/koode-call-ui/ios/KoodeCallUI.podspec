Pod::Spec.new do |s|
  s.name           = 'KoodeCallUI'
  s.version        = '0.1.0'
  s.summary        = 'In-call screen behaviour for Koode (proximity sensor).'
  s.license        = 'UNLICENSED'
  s.author         = 'Koode'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
