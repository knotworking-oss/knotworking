"use client";

import { MAX_WORKSPACE_AVATAR_LENGTH, WORKSPACE_AVATAR_SIZE } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { WorkspaceAvatar } from "@/components/workspace-avatar";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const acceptedTypes = ["image/png", "image/jpeg", "image/webp"];
const maxFileBytes = 5 * 1024 * 1024;

async function resizeAvatar(file: File): Promise<string> {
  if (!acceptedTypes.includes(file.type) || file.size > maxFileBytes) {
    throw new Error("Choose a PNG, JPEG or WebP file up to 5 MB.");
  }
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = WORKSPACE_AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the image.");
    const crop = Math.min(image.width, image.height);
    context.drawImage(
      image,
      (image.width - crop) / 2,
      (image.height - crop) / 2,
      crop,
      crop,
      0,
      0,
      WORKSPACE_AVATAR_SIZE,
      WORKSPACE_AVATAR_SIZE,
    );
    const data = canvas.toDataURL("image/png");
    if (data.length > MAX_WORKSPACE_AVATAR_LENGTH) throw new Error("Choose a simpler image.");
    return data;
  } finally {
    image.close();
  }
}

export function WorkspaceAvatarForm({ slug }: { slug: string }) {
  const { idx, viewer } = useWorkspace();
  const { name, icon } = idx.boot.workspace;
  const canEdit = viewer.role === "owner";
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function save(file: File | null) {
    setPending(true);
    try {
      const avatar = file ? await resizeAvatar(file) : null;
      await unwrap(
        browserApi().v1.workspaces[":slug"].settings.$patch({
          param: { slug },
          json: { icon: avatar },
        }),
      );
      toast.success(avatar ? "Workspace avatar updated" : "Workspace avatar removed");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <h3 className="font-medium">Workspace avatar</h3>
      <Card className="flex flex-col gap-3 px-4">
        <div className="flex items-center gap-3">
          <WorkspaceAvatar name={name} icon={icon} />
          <p className="text-sm text-muted-foreground">Visible to everyone in this workspace.</p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="file"
              className="max-w-xs"
              aria-label="Upload workspace avatar"
              accept={acceptedTypes.join(",")}
              disabled={pending}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void save(file);
              }}
            />
            {icon?.startsWith("data:image/") && (
              <Button type="button" variant="outline" disabled={pending} onClick={() => void save(null)}>
                Remove avatar
              </Button>
            )}
            {pending && <Spinner aria-label="Saving workspace avatar" />}
          </div>
        )}
      </Card>
    </section>
  );
}
