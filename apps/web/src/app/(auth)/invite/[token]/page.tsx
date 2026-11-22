import { Button } from "@knotworking/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@knotworking/ui/components/empty";
import { Card } from "@knotworking/ui/components/card";
import { MailX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getInvitation } from "@/lib/api";
import { AcceptInviteForm } from "./accept-form";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await getInvitation(token);
  if (!invite) {
    return (
      <Card>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MailX />
            </EmptyMedia>
            <EmptyTitle>Invitation not valid</EmptyTitle>
            <EmptyDescription>
              This link has expired, was already used, or was revoked. Ask a workspace admin to send a new
              one.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link href="/login">Go to sign in</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </Card>
    );
  }
  return <AcceptInviteForm token={token} invite={invite} />;
}
