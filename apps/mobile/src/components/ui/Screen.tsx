import type { ReactNode } from 'react';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { cn } from '@/lib/cn';

type ScreenProps = {
  children: ReactNode;
  className?: string;
  edges?: Edge[];
};

/** Full-bleed themed screen container that respects safe areas. */
export function Screen({ children, className, edges = ['top', 'bottom'] }: ScreenProps) {
  return (
    <SafeAreaView edges={edges} className={cn('flex-1 bg-background', className)}>
      {children}
    </SafeAreaView>
  );
}
