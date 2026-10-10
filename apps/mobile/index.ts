// App entry. Background notification tasks must be defined before anything
// else runs: Android can start the JS bundle headless (no UI) to handle them.
import './src/features/notifications/background';
// Android calls: keeps JS timers running while a call is in the background.
import './src/features/calls/keepAlive';
import 'expo-router/entry';
