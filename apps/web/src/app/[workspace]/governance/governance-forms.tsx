"use client";

import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { FieldGroup } from "@knotworking/ui/components/field";
import { Spinner } from "@knotworking/ui/components/spinner";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/auth-client";

/** Shared submit-and-refresh for the governance dialogs. */
export function useSubmit(onClose: () => void) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return {
    pending,
    submit: async (fn: () => Promise<unknown>, done: string) => {
      setPending(true);
      try {
        await fn();
        toast.success(done);
        onClose();
        router.refresh();
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setPending(false);
      }
    },
  };
}

/** A dialog with a form, a title and Cancel / submit buttons. */
export function FormDialog({
  title,
  description,
  submitLabel,
  pending,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <FieldGroup className="py-4">{children}</FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
