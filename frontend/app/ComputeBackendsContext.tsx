// Phase F: three operations × two backends — global preference store.
//
// Stores per-operation backend preferences in localStorage so the user
// flips Inference to 0G once and the choice survives refreshes. Pages
// that trigger an operation (training page, match page, coach UI)
// read the current value via useComputeBackends() and pass it as the
// relevant flag to the backend.
//
// Keys are deliberately stable: `chaingammon.computeBackends` is the
// only key written; the value is a JSON object {coach, inference,
// training}. New operations get added by extending the OPERATIONS
// const + the type here.
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Backend = "local" | "0g";

export type ComputeOperation = "coach" | "inference" | "training";

export type ComputeBackends = Record<ComputeOperation, Backend>;

const STORAGE_KEY = "chaingammon.computeBackends";

const DEFAULTS: ComputeBackends = {
  coach: "local",
  inference: "local",
  training: "local",
};

interface ContextValue {
  backends: ComputeBackends;
  setBackend: (op: ComputeOperation, value: Backend) => void;
  hydrated: boolean;
}

const ComputeBackendsContext = createContext<ContextValue>({
  backends: DEFAULTS,
  setBackend: () => {},
  hydrated: false,
});

export function ComputeBackendsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [backends, setBackends] = useState<ComputeBackends>(DEFAULTS);
  // Defer localStorage reads until after hydration so the server-rendered
  // HTML and the initial client render agree (Sidebar.tsx does the same).
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ComputeBackends>;
        setBackends({ ...DEFAULTS, ...parsed });
      }
    } catch {
      // Malformed JSON or quota exceeded — fall back to defaults.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(backends));
    } catch {
      // Private mode / quota exceeded — silently drop. The in-memory
      // state still works for this session.
    }
  }, [backends, hydrated]);

  const setBackend = useCallback(
    (op: ComputeOperation, value: Backend) => {
      setBackends((prev) => ({ ...prev, [op]: value }));
    },
    []
  );

  const value = useMemo(
    () => ({ backends, setBackend, hydrated }),
    [backends, setBackend, hydrated]
  );

  return (
    <ComputeBackendsContext.Provider value={value}>
      {children}
    </ComputeBackendsContext.Provider>
  );
}

export function useComputeBackends(): ContextValue {
  return useContext(ComputeBackendsContext);
}
