Pod::Spec.new do |s|
  s.name           = 'KoodeCalls'
  s.version        = '0.1.0'
  s.summary        = 'PushKit + CallKit integration for Koode incoming calls.'
  s.license        = 'UNLICENSED'
  s.author         = 'Koode'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # CallKit owns the audio session during a call; WebRTC must be told when it
  # activates. Same WebRTC build as @livekit/react-native-webrtc.
  s.dependency 'LiveKitWebRTC'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
