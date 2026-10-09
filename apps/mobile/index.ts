// App entry. Background notification tasks must be defined before anything
// else runs: Android can start the JS bundle headless (no UI) to handle them.
import './src/features/notifications/background';
import 'expo-router/entry';
