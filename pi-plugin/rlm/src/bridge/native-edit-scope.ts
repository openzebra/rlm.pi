let activeNativeEditInvocations = 0;

export function beginNativeEditInvocation(): () => void {
  activeNativeEditInvocations++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeNativeEditInvocations = Math.max(0, activeNativeEditInvocations - 1);
  };
}

export function isNativeEditInvocationActive(): boolean {
  return activeNativeEditInvocations > 0;
}
