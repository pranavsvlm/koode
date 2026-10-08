import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, Pressable, View } from 'react-native';
import { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { haptics } from '@/lib/haptics';
import type { ColorToken } from '@/theme/tokens';
import { GlassSurface } from './GlassSurface';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { MotionView } from './MotionView';

type Tone = 'info' | 'success' | 'error';
export type ToastOptions = { title: string; message?: string; tone?: Tone };
type ToastApi = { show: (options: ToastOptions) => void };

const TONE: Record<Tone, { icon: IconName; color: ColorToken }> = {
  info: { icon: 'info', color: 'accent' },
  success: { icon: 'check-circle', color: 'success' },
  error: { icon: 'info', color: 'danger' },
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<(ToastOptions & { id: number }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((options: ToastOptions) => {
    clearTimeout(timer.current);
    if (options.tone === 'success') haptics.success();
    else if (options.tone === 'error') haptics.warning();
    setToast({ ...options, id: Date.now() });
    AccessibilityInfo.announceForAccessibility(
      options.message ? `${options.title}. ${options.message}` : options.title,
    );
    timer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const tone = TONE[toast?.tone ?? 'info'];

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <View
        pointerEvents="box-none"
        className="absolute left-0 right-0"
        style={{ top: insets.top + 8 }}
      >
        {toast && (
          <MotionView
            key={toast.id}
            entering={FadeInUp.springify().damping(18)}
            exiting={FadeOutUp.duration(180)}
            className="mx-4 overflow-hidden rounded-xl"
            style={{
              shadowColor: '#000',
              shadowOpacity: 0.12,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 6 },
              elevation: 6,
            }}
          >
            <Pressable onPress={() => setToast(null)} accessibilityRole="alert">
              <GlassSurface style={{ borderRadius: 22 }}>
                <View className="flex-row items-center gap-3 px-4 py-3.5">
                  <Icon name={tone.icon} size={20} color={tone.color} />
                  <View className="flex-1">
                    <Text variant="subhead" className="font-semibold">
                      {toast.title}
                    </Text>
                    {toast.message && (
                      <Text variant="footnote" tone="secondary">
                        {toast.message}
                      </Text>
                    )}
                  </View>
                </View>
              </GlassSurface>
            </Pressable>
          </MotionView>
        )}
      </View>
    </ToastContext.Provider>
  );
}
