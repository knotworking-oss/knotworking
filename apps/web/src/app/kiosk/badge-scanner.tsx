"use client";

import { normalizeBadgeCode } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { CameraOff } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

/** The parts of the Barcode Detection API we use (not in TypeScript's DOM library yet). */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorClass = new (options: { formats: string[] }) => BarcodeDetectorLike;

const detectorClass = () =>
  (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector ?? null;

/**
 * Reads a kiosk badge: the camera scans its QR code where the browser has `BarcodeDetector`
 * (Chrome and Edge on Android, ChromeOS and macOS, Safari 17+), and the code printed under it can
 * be typed instead. A handheld scanner that types into the field works too.
 */
export function BadgeScanner({ onCode, onCancel }: { onCode: (code: string) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState<"starting" | "on" | "unavailable">("starting");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  // The parent re-renders (the clock ticks): keep the camera running across new callbacks.
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    const Detector = detectorClass();
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setCamera("unavailable");
      return;
    }
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const detector = new Detector({ formats: ["qr_code"] });
    const scan = async () => {
      if (stopped || done.current || !video.current) return;
      try {
        const found = await detector.detect(video.current);
        for (const b of found) {
          const code = normalizeBadgeCode(b.rawValue);
          if (code && !done.current) {
            done.current = true;
            onCodeRef.current(code);
            return;
          }
        }
      } catch {}
      timer = setTimeout(scan, 250);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then(async (s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => {});
        }
        setCamera("on");
        void scan();
      })
      .catch(() => setCamera("unavailable"));
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeBadgeCode(typed);
    if (!code) return setError("That isn't a badge code. It is the 16 letters and digits under the QR code.");
    done.current = true;
    onCode(code);
  };

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <p className="text-2xl font-semibold">Scan your badge</p>
      {camera !== "unavailable" ? (
        <div className="relative aspect-square w-full max-w-72 overflow-hidden rounded-xl border bg-muted">
          <video ref={video} muted playsInline className="size-full -scale-x-100 object-cover" />
          <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-primary/70" />
        </div>
      ) : (
        <p className="flex items-center gap-2 text-muted-foreground">
          <CameraOff className="size-5" /> This tablet can't scan codes: type the code from your badge.
        </p>
      )}
      <form onSubmit={submit} className="flex w-full flex-col gap-2">
        <Input
          aria-label="Badge code"
          autoFocus={camera === "unavailable"}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          className="h-14 text-center font-mono text-xl tracking-widest"
          maxLength={40}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setError(null);
          }}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="h-14 text-lg" disabled={!typed.trim()}>
          Continue
        </Button>
      </form>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
