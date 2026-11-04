import { useCallback, useLayoutEffect, useRef } from "react";

/** Keep memoized children stable while events use the latest committed state. */
export function useStableCallback<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const current = useRef(handler);
  useLayoutEffect(() => {
    current.current = handler;
  }, [handler]);
  return useCallback((...args: Args) => current.current(...args), []);
}
