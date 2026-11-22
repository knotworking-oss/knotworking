import "@knotworking/ui/globals.css";
import { Toaster } from "@knotworking/ui/components/sonner";
import { TooltipProvider } from "@knotworking/ui/components/tooltip";
import { cn } from "@knotworking/ui/lib/utils";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: { default: "Knotworking", template: "%s · Knotworking" },
  description: "Tasks, projects and docs for teams that move fast.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("font-sans antialiased", GeistSans.variable, GeistMono.variable)}
    >
      <body>
        <ThemeProvider>
          <TooltipProvider>
            {children}
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
