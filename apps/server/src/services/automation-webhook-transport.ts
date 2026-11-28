import { createHmac } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIPv4 } from "node:net";
import { badRequest } from "../errors";

// IANA special-purpose addresses and the multicast range are outside the allowed
// public unicast destinations. Deny whole reserved blocks, including anycast exceptions.
const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(address, prefix);
}

const isPublicAddress = (address: string) => isIPv4(address) && !blockedAddresses.check(address);
const resolver = new Resolver({ timeout: 3_000, tries: 2 });

export function validateAutomationWebhookUrl(value: string): URL {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || url.protocol !== "https:" || url.username || url.password || url.hash)
    throw badRequest("Enter an HTTPS webhook URL without credentials or a fragment");

  const host = url.hostname.replace(/\.$/, "");
  if (!host.includes(".") || host.endsWith(".localhost") || (isIPv4(host) && !isPublicAddress(host)))
    throw badRequest("The webhook destination must use public IPv4");
  return url;
}

/** Sign the exact body sent over TLS. The same delivery ID is kept across retries. */
export async function deliverAutomationWebhook({
  url: value,
  secret,
  deliveryId,
  body,
}: {
  url: string;
  secret: string;
  deliveryId: string;
  body: string;
}): Promise<number> {
  const url = validateAutomationWebhookUrl(value);
  const addresses = isIPv4(url.hostname)
    ? [url.hostname]
    : await resolver.resolve4(url.hostname).catch(() => {
        throw new Error("Could not resolve the webhook destination to IPv4");
      });
  const [address] = addresses;
  if (!address || addresses.some((candidate) => !isPublicAddress(candidate)))
    throw new Error("The webhook destination must use public IPv4");

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${deliveryId}.${body}`).digest("hex");

  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "POST",
        agent: false,
        family: 4,
        // Keep the original name for Host and certificate verification, but connect
        // to the validated address without doing another DNS lookup.
        lookup: (_hostname, _options, callback) => callback(null, address, 4),
        rejectUnauthorized: true,
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-knotworking-delivery": deliveryId,
          "x-knotworking-timestamp": timestamp,
          "x-knotworking-signature": `sha256=${signature}`,
        },
      },
      (response) => {
        if (response.statusCode) resolve(response.statusCode);
        else reject(new Error("The webhook endpoint returned no HTTP status"));
        // The sender only uses the status. Avoid downloading unbounded response bodies.
        response.destroy();
      },
    );
    outgoing.on("error", () => reject(new Error("The webhook HTTPS request failed")));
    outgoing.end(body);
  });
}
