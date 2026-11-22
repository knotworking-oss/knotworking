import type { Metadata, Viewport } from "next";
import { Kiosk } from "./kiosk";

export const metadata: Metadata = { title: "Kiosk" };
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

/** The attendance kiosk: a paired tablet, no sign-in. Everything happens in the browser. */
export default function KioskPage() {
  return <Kiosk />;
}
