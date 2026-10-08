import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { FadeIn, ZoomIn } from 'react-native-reanimated';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import { Text } from './Text';
import { MotionView } from './MotionView';

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type DialogApi = { confirm: (options: ConfirmOptions) => Promise<boolean> };

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used inside <DialogProvider>');
  return ctx;
}

/** Promise-based confirmation dialogs: `if (await dialog.confirm({...})) …` */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    resolver.current?.(false);
    if (next.destructive) haptics.warning();
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOptions(null);
  };

  return (
    <DialogContext.Provider value={{ confirm }}>
      {children}
      <Modal
        transparent
        visible={!!options}
        animationType="none"
        statusBarTranslucent
        onRequestClose={() => close(false)}
      >
        {options && (
          <View className="flex-1 items-center justify-center px-10">
            <MotionView
              entering={FadeIn.duration(150)}
              className="bg-scrim/40"
              style={StyleSheet.absoluteFill}
            />
            <MotionView
              entering={ZoomIn.springify().damping(18).stiffness(260)}
              accessibilityViewIsModal
              accessibilityRole="alert"
              className="w-full max-w-[320px] overflow-hidden rounded-xl bg-surface-raised"
            >
              <View className="gap-1.5 px-5 pb-4 pt-5">
                <Text variant="headline" className="text-center">
                  {options.title}
                </Text>
                {options.message && (
                  <Text variant="subhead" tone="secondary" className="text-center">
                    {options.message}
                  </Text>
                )}
              </View>
              <View className="h-px bg-separator" />
              <View className="flex-row">
                <DialogAction
                  label={options.cancelLabel ?? 'Cancel'}
                  onPress={() => close(false)}
                />
                <View className="w-px bg-separator" />
                <DialogAction
                  label={options.confirmLabel ?? 'OK'}
                  destructive={options.destructive}
                  emphasized
                  onPress={() => close(true)}
                />
              </View>
            </MotionView>
          </View>
        )}
      </Modal>
    </DialogContext.Provider>
  );
}

function DialogAction({
  label,
  onPress,
  destructive,
  emphasized,
}: {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  emphasized?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="h-12 flex-1 items-center justify-center active:bg-fill"
    >
      <Text
        variant="body"
        tone={destructive ? 'danger' : 'accent'}
        className={cn(emphasized && 'font-semibold')}
      >
        {label}
      </Text>
    </Pressable>
  );
}
