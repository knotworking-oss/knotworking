"use client";

import { Button } from "@knotworking/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@knotworking/ui/components/input-group";
import { Check, Copy, Download } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

/**
 * A one-time link (invite, password reset) as a QR code plus copy field.
 * Scan it from a phone, show it on screen in a meeting, or paste it into chat.
 */
export function ShareLink({ url, filename = "knotworking-link" }: { url: string; filename?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(url, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0a0a0a", light: "#ffffff" },
    })
      .then((s) => !cancelled && setSvg(s))
      .catch(() => !cancelled && setSvg(null));
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function download() {
    const dataUrl = await QRCode.toDataURL(url, { width: 768, margin: 2, errorCorrectionLevel: "M" });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${filename}.png`;
    a.click();
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        role="img"
        aria-label="QR code for the link"
        className="size-48 rounded-xl bg-white p-2 ring-1 ring-foreground/10 [&_svg]:size-full"
        // Generated locally by the qrcode library from a URL we created.
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      <InputGroup>
        <InputGroupInput
          value={url}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label="Copy link"
            onClick={async () => {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check /> : <Copy />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <Button variant="ghost" size="sm" onClick={download}>
        <Download /> Download QR code
      </Button>
    </div>
  );
}
