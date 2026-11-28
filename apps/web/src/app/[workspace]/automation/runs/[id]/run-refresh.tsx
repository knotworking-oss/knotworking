"use client";

import { Button } from "@knotworking/ui/components/button";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function RunRefresh({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => router.refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [router, running]);
  return (
    <Button size="sm" variant="ghost" onClick={() => router.refresh()}>
      <RefreshCw /> Refresh
    </Button>
  );
}
