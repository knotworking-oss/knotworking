import { Button } from "@knotworking/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@knotworking/ui/components/empty";
import { LockKeyhole } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthConfig, getOptionalMe } from "@/lib/api";

export default async function Home() {
  const [me, config] = await Promise.all([getOptionalMe(), getAuthConfig()]);
  if (!me) redirect(config.needsSetup ? "/setup" : "/login");
  const first = me.workspaces[0];
  if (first) redirect(`/${first.slug}`);
  return (
    <Empty className="min-h-dvh">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockKeyhole />
        </EmptyMedia>
        <EmptyTitle>No workspace access</EmptyTitle>
        <EmptyDescription>
          You&apos;re signed in as {me.user.email}, but you aren&apos;t a member of any workspace.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link href="/login">Use another account</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
