import Storage from 'expo-sqlite/kv-store';
import { usePreferences } from '../preferences';

describe('usePreferences', () => {
  it('defaults to the system appearance', () => {
    expect(usePreferences.getState().appearance).toBe('system');
  });

  it('persists appearance changes', async () => {
    usePreferences.getState().setAppearance('dark');
    expect(usePreferences.getState().appearance).toBe('dark');
    const stored = JSON.parse((await Storage.getItem('koode.preferences')) ?? '{}');
    expect(stored.state.appearance).toBe('dark');
  });
});
