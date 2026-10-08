import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Pressable, Text as RNText } from 'react-native';
import { Avatar, initialsOf } from '../Avatar';
import { Button } from '../Button';
import { DialogProvider, useDialog } from '../Dialog';
import { EmptyState } from '../EmptyState';
import { ListRow } from '../List';
import { SegmentedControl } from '../SegmentedControl';

describe('initialsOf', () => {
  it.each([
    ['Maya Chen', 'MC'],
    ['Grandma Rose', 'GR'],
    ['Priya', 'P'],
    ['  chloé   de  dubois ', 'CD'],
    ['', '?'],
  ])('%s → %s', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });
});

describe('Avatar', () => {
  it('announces online presence', async () => {
    await render(<Avatar id="maya" name="Maya Chen" online />);
    expect(screen.getByLabelText('Maya Chen, online')).toBeTruthy();
  });
});

describe('Button', () => {
  it('calls onPress', async () => {
    const onPress = jest.fn();
    await render(<Button label="Continue" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is disabled while loading', async () => {
    const onPress = jest.fn();
    await render(<Button label="Save" onPress={onPress} loading />);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('ListRow', () => {
  it('exposes check state to assistive tech', async () => {
    await render(
      <ListRow title="Dark" accessory={{ type: 'check', checked: true }} onPress={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Dark' })).toBeSelected();
  });

  it('toggles a switch', async () => {
    const onValueChange = jest.fn();
    await render(
      <ListRow title="Read Receipts" accessory={{ type: 'switch', value: false, onValueChange }} />,
    );
    fireEvent(screen.getByRole('switch', { name: 'Read Receipts' }), 'valueChange', true);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });
});

describe('EmptyState', () => {
  it('renders its action', async () => {
    const onPress = jest.fn();
    await render(
      <EmptyState
        icon="chats"
        title="No conversations yet"
        action={{ label: 'Start a chat', onPress }}
      />,
    );
    expect(screen.getByRole('header', { name: 'No conversations yet' })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Start a chat' }));
    expect(onPress).toHaveBeenCalled();
  });
});

describe('SegmentedControl', () => {
  it('marks the selected tab and reports changes', async () => {
    const onChange = jest.fn();
    await render(
      <SegmentedControl
        options={[
          { value: 'all', label: 'All' },
          { value: 'missed', label: 'Missed' },
        ]}
        value="all"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('tab', { name: 'All' })).toBeSelected();
    fireEvent.press(screen.getByRole('tab', { name: 'Missed' }));
    expect(onChange).toHaveBeenCalledWith('missed');
  });
});

describe('Dialog', () => {
  function Harness({ onResult }: { onResult: (v: boolean) => void }) {
    const dialog = useDialog();
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void dialog
            .confirm({ title: 'Delete?', confirmLabel: 'Delete', destructive: true })
            .then(onResult);
        }}
      >
        <RNText>Open</RNText>
      </Pressable>
    );
  }

  it('resolves true on confirm and false on cancel', async () => {
    const onResult = jest.fn();
    await render(
      <DialogProvider>
        <Harness onResult={onResult} />
      </DialogProvider>,
    );
    await act(async () => fireEvent.press(screen.getByText('Open')));
    await act(async () => fireEvent.press(screen.getByText('Delete')));
    expect(onResult).toHaveBeenLastCalledWith(true);

    await act(async () => fireEvent.press(screen.getByText('Open')));
    await act(async () => fireEvent.press(screen.getByText('Cancel')));
    expect(onResult).toHaveBeenLastCalledWith(false);
  });
});
