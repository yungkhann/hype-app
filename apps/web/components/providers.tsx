"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { useEffect, useState, type ReactNode } from "react";
import { Toaster } from "sonner";

/** Records whether the last interaction was pointer or keyboard on <html data-input>, for focus styling. */
function useInputModality() {
  useEffect(() => {
    const root = document.documentElement;
    const pointer = () => root.setAttribute("data-input", "pointer");
    const keyboard = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey) root.setAttribute("data-input", "keyboard");
    };
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", keyboard, true);
    return () => {
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", keyboard, true);
    };
  }, []);
}

export function Providers({ children }: { children: ReactNode }) {
  useInputModality();
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
          mutations: { retry: 0 },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={250} skipDelayDuration={100}>
        {children}
        <Toaster
          theme="dark"
          position="bottom-right"
          closeButton
          toastOptions={{
            classNames: {
              toast: "!rounded-lg !border !border-line-strong !bg-raised !text-ink !shadow-overlay !font-sans !text-dense",
              description: "!text-ink-2",
            },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
