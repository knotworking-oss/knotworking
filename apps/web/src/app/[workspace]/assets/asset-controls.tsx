"use client";

import { Button } from "@knotworking/ui/components/button";
import { Archive, ArchiveRestore, PencilLine, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AssetDialog, type EditableAsset } from "@/components/asset-dialog";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

type Area = { id: string; name: string; code: string | null };
type Member = { id: string; name: string };

/** "Add asset" on the register (write access). */
export function NewAsset({ slug, areas, members }: { slug: string; areas: Area[]; members: Member[] }) {
  const { can } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!can("assets", "write")) return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus /> Add asset
      </Button>
      {open && <AssetDialog slug={slug} areas={areas} members={members} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Edit (write) and archive or restore (manage) one asset. */
export function AssetActions({
  slug,
  asset,
  status,
  areas,
  members,
}: {
  slug: string;
  asset: EditableAsset;
  status: "active" | "archived";
  areas: Area[];
  members: Member[];
}) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  async function setStatus(action: "archive" | "restore") {
    setPending(true);
    try {
      const api = browserApi().v1.workspaces[":slug"].assets[":id"];
      await unwrap(
        (action === "archive" ? api.archive : api.restore).$post({ param: { slug, id: asset.id } }),
      );
      toast.success(action === "archive" ? `${asset.name} archived` : `${asset.name} restored`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      {can("assets", "write") && status === "active" && (
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          <PencilLine /> Edit
        </Button>
      )}
      {can("assets", "manage") && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void setStatus(status === "active" ? "archive" : "restore")}
        >
          {status === "active" ? <Archive /> : <ArchiveRestore />}
          {status === "active" ? "Archive" : "Restore"}
        </Button>
      )}
      {editing && (
        <AssetDialog
          slug={slug}
          asset={asset}
          areas={areas}
          members={members}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
