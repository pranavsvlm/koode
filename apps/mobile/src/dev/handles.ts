/**
 * DEVELOPMENT ONLY: screens register the handlers their buttons call, so the
 * screen tour can drive them on a Simulator that can't be tapped.
 */
export const devHandles: {
  composer?: {
    startRecording: () => Promise<void>;
    sendRecording: () => Promise<void>;
    focus: () => void;
  };
} = {};
