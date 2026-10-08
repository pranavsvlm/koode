import { router } from 'expo-router';
import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KoodeMark } from '@/components/brand/KoodeMark';
import { Button, Icon, Text, type IconName } from '@/components/ui';
import { MotionView } from '@/components/ui/MotionView';

const PAGES: { icon?: IconName; title: string; body: string }[] = [
  {
    title: 'Just your people',
    body: 'Koode is invite-only. A private place for the family and friends you actually talk to.',
  },
  {
    icon: 'video',
    title: 'Calls that feel close',
    body: 'Crisp voice and video calls, from a quick hello to Sunday catch-ups with Grandma.',
  },
  {
    icon: 'lock',
    title: 'Private by design',
    body: 'No ads. No trackers. No phone number or email needed — just an invite from someone you know.',
  },
];

function Page({
  index,
  scrollX,
  width,
}: {
  index: number;
  scrollX: SharedValue<number>;
  width: number;
}) {
  const page = PAGES[index]!;
  const art = useAnimatedStyle(() => {
    const p = scrollX.value / width - index;
    return {
      opacity: interpolate(p, [-0.6, 0, 0.6], [0, 1, 0], 'clamp'),
      transform: [
        { translateX: interpolate(p, [-1, 0, 1], [width * 0.35, 0, -width * 0.35]) },
        { scale: interpolate(p, [-1, 0, 1], [0.8, 1, 0.8], 'clamp') },
      ],
    };
  });
  const copy = useAnimatedStyle(() => {
    const p = scrollX.value / width - index;
    return {
      opacity: interpolate(p, [-0.5, 0, 0.5], [0, 1, 0], 'clamp'),
      transform: [{ translateY: interpolate(p, [-1, 0, 1], [16, 0, 16], 'clamp') }],
    };
  });

  return (
    <View style={{ width }} className="flex-1 items-center justify-center px-8">
      <MotionView animatedStyle={art} className="mb-12 h-40 items-center justify-center">
        {page.icon ? (
          <View className="h-32 w-32 items-center justify-center rounded-[40px] bg-accent/10">
            <Icon name={page.icon} size={56} color="accent" />
          </View>
        ) : (
          <KoodeMark size={140} />
        )}
      </MotionView>
      <MotionView animatedStyle={copy} className="items-center gap-3">
        <Text variant="large-title" className="text-center">
          {page.title}
        </Text>
        <Text variant="body" tone="secondary" className="text-center">
          {page.body}
        </Text>
      </MotionView>
    </View>
  );
}

function Dot({
  index,
  scrollX,
  width,
}: {
  index: number;
  scrollX: SharedValue<number>;
  width: number;
}) {
  const style = useAnimatedStyle(() => {
    const p = Math.abs(scrollX.value / width - index);
    return {
      width: interpolate(p, [0, 1], [22, 7], 'clamp'),
      opacity: interpolate(p, [0, 1], [1, 0.3], 'clamp'),
    };
  });
  return <MotionView className="h-[7px] rounded-full bg-text" animatedStyle={style} />;
}

export default function WelcomeScreen() {
  const { width } = useWindowDimensions();
  const scrollX = useSharedValue(0);
  const [page, setPage] = useState(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollX.value = e.contentOffset.x;
  });

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <Animated.ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        accessibilityLabel={`Introduction, page ${page + 1} of ${PAGES.length}`}
      >
        {PAGES.map((_, i) => (
          <Page key={i} index={i} scrollX={scrollX} width={width} />
        ))}
      </Animated.ScrollView>

      <View className="gap-8 px-6 pb-4">
        <View
          className="flex-row justify-center gap-1.5"
          importantForAccessibility="no-hide-descendants"
        >
          {PAGES.map((_, i) => (
            <Dot key={i} index={i} scrollX={scrollX} width={width} />
          ))}
        </View>
        <View className="gap-2">
          <Button label="I have an invite" onPress={() => router.push('/invite')} fullWidth />
          <Button
            label="I already have an account"
            variant="plain"
            onPress={() => router.push('/sign-in')}
            fullWidth
          />
        </View>
      </View>
    </SafeAreaView>
  );
}
