"use client";

import { createContext } from "react";

// Secondary settings links use the same draft-save and busy guards as the sidebar.
export const AppNavigationContext = createContext<{
  navigate: (href: string) => void;
  disabled: boolean;
} | null>(null);
