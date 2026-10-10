import { Avatar, type AvatarProps } from '@/components/ui';
import type { AvatarPhoto } from '@/domain/types';
import { usePhotoUri } from './photos';

/** A person's avatar: their profile photo once it's known, initials until then. */
export function ProfileAvatar({ photo, ...props }: AvatarProps & { photo?: AvatarPhoto }) {
  const uri = usePhotoUri(photo);
  return <Avatar {...props} source={uri ? { uri } : props.source} />;
}
