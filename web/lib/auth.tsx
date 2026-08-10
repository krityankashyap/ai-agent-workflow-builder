"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { StoredSession } from "@nhost/nhost-js/session";
import { nhost } from "./nhost";

interface AuthState {
  session: StoredSession | null;
  isLoading: boolean;
  userId: string | null;
  email: string | null;
}

const AuthContext = createContext<AuthState>({
  session: null,
  isLoading: true,
  userId: null,
  email: null,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Seed from whatever is already persisted (localStorage) on first paint.
    setSession(nhost.getUserSession());
    setIsLoading(false);

    // Keep React in sync with the SDK: it fires onChange on sign-in, sign-out,
    // and background token refresh, so the UI reacts with no manual polling.
    const unsubscribe = nhost.sessionStorage.onChange((next) => {
      setSession(next);
    });
    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        session,
        isLoading,
        userId: session?.user?.id ?? null,
        email: session?.user?.email ?? null,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
