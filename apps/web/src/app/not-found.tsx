import { Button } from "@knotworking/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@knotworking/ui/components/empty";
import { SearchX } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <Empty className="min-h-[60dvh]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX />
        </EmptyMedia>
        <EmptyTitle>Not found</EmptyTitle>
        <EmptyDescription>This page doesn&apos;t exist or you don&apos;t have access to it.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link href="/">Go home</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
