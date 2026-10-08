import { View } from 'react-native';
import { FadeIn } from 'react-native-reanimated';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { MotionView } from './MotionView';

export type EmptyStateProps = {
  icon: IconName;
  title: string;
  message?: string;
  action?: { label: string; onPress: () => void };
};

export function EmptyState({ icon, title, message, action }: EmptyStateProps) {
  return (
    <MotionView entering={FadeIn.duration(250)} className="items-center px-10 py-16">
      <View className="mb-5 h-20 w-20 items-center justify-center rounded-full bg-accent/10">
        <Icon name={icon} size={34} color="accent" />
      </View>
      <Text variant="title3" className="text-center">
        {title}
      </Text>
      {message && (
        <Text variant="subhead" tone="secondary" className="mt-2 text-center">
          {message}
        </Text>
      )}
      {action && (
        <Button label={action.label} onPress={action.onPress} size="md" className="mt-6" />
      )}
    </MotionView>
  );
}
