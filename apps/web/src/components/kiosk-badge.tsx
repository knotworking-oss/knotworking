"use client";

import { formatBadgeCode, KIOSK_BADGE_PREFIX } from "@knotworking/core";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** The QR code on a kiosk badge: the badge code with its prefix, nothing else. */
export const badgeQrSvg = (code: string) =>
  QRCode.toString(`${KIOSK_BADGE_PREFIX}${code}`, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0a0a0a", light: "#ffffff" },
  });

/**
 * A kiosk badge as it prints: the person's name, the workspace, a QR code holding an opaque code
 * (never the staff number or PIN) and the same code in groups of four for typing.
 */
export function KioskBadgeCard({
  name,
  workspaceName,
  code,
}: {
  name: string;
  workspaceName: string;
  code: string;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    badgeQrSvg(code)
      .then((s) => !cancelled && setSvg(s))
      .catch(() => !cancelled && setSvg(null));
    return () => {
      cancelled = true;
    };
  }, [code]);
  return (
    <div className="flex w-56 flex-col items-center gap-2 rounded-xl border bg-white p-4 text-center text-neutral-950 shadow-xs">
      <p className="text-xs tracking-wide text-neutral-500 uppercase">{workspaceName}</p>
      <p className="text-lg leading-tight font-semibold">{name}</p>
      <div
        role="img"
        aria-label="Badge QR code"
        className="size-36 [&_svg]:size-full"
        // Generated locally by the qrcode library from a code the API issued.
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      <p className="font-mono text-xs tracking-wider">{formatBadgeCode(code)}</p>
      <p className="text-[10px] text-neutral-500">Scan at the kiosk to clock in</p>
    </div>
  );
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Prints a badge (credit-card size, 85.6 × 54 mm) from a window of its own, so nothing else on
 * the page is printed and the code isn't kept in the page or the URL.
 */
export async function printKioskBadge(badge: { name: string; workspaceName: string; code: string }) {
  const svg = await badgeQrSvg(badge.code);
  const w = window.open("", "_blank", "width=480,height=420");
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Kiosk badge</title>
<style>
  @page { size: 85.6mm 54mm; margin: 0; }
  html, body { margin: 0; font-family: system-ui, sans-serif; color: #0a0a0a; }
  .card { box-sizing: border-box; width: 85.6mm; height: 54mm; padding: 4mm 5mm; display: flex; gap: 4mm; align-items: center; border: 0.2mm solid #ddd; }
  .qr { width: 36mm; height: 36mm; flex: none; } .qr svg { width: 100%; height: 100%; }
  .ws { font-size: 7pt; text-transform: uppercase; letter-spacing: .05em; color: #666; }
  .name { font-size: 13pt; font-weight: 600; margin: 1mm 0 3mm; line-height: 1.15; }
  .code { font-family: ui-monospace, monospace; font-size: 8pt; letter-spacing: .05em; }
  .hint { font-size: 6.5pt; color: #666; margin-top: 2mm; }
  @media print { .card { border: none; } }
</style></head><body><div class="card"><div class="qr">${svg}</div><div>
<div class="ws">${escapeHtml(badge.workspaceName)}</div><div class="name">${escapeHtml(badge.name)}</div>
<div class="code">${escapeHtml(formatBadgeCode(badge.code))}</div><div class="hint">Scan at the kiosk to clock in</div>
</div></div></body></html>`);
  w.document.close();
  w.focus();
  w.print();
  return true;
}
