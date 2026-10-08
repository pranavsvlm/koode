import { render, screen } from '@testing-library/react-native';
import { Text } from '../Text';

describe('Text', () => {
  it('exposes title variants as accessibility headers', async () => {
    await render(<Text variant="title1">Chats</Text>);
    expect(screen.getByRole('header')).toHaveTextContent('Chats');
  });

  it('does not mark body text as a header', async () => {
    await render(<Text>Hello</Text>);
    expect(screen.queryByRole('header')).toBeNull();
    expect(screen.getByText('Hello')).toBeTruthy();
  });
});
