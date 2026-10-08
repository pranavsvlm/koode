import { Image } from 'expo-image';
import { cssInterop } from 'nativewind';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components NativeWind does not style out of the box. Register once at startup
// so `className` works on them like on core React Native views.
//
// Do NOT register Reanimated's Animated.View: NativeWind then re-wraps any
// Animated.View that receives an animated style and drops its static styles.
// Use <MotionView> / <MotionPressable> (components/ui/MotionView) instead.
cssInterop(Image, { className: 'style' });
cssInterop(SafeAreaView, { className: 'style' });
