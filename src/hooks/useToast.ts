import { useCallback, useEffect, useRef, useState } from "react";
import { TOAST_DURATION_MS } from "../types";

/**
 * Ephemeral status message. A new toast replaces the previous one
 * and resets the hide timer so rapid actions don't clear the latest message.
 */
export function useToast(durationMs = TOAST_DURATION_MS) {
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearToast = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast(null);
  }, []);

  const showToast = useCallback(
    (message: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setToast(message);
      timerRef.current = setTimeout(() => {
        setToast(null);
        timerRef.current = null;
      }, durationMs);
    },
    [durationMs],
  );

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { toast, showToast, clearToast };
}
