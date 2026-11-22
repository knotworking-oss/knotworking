"use client";

import { WORKSPACE_AVATAR_PATTERN } from "@knotworking/core";
import Image from "next/image";
import { useState } from "react";

export function WorkspaceAvatar({ name, icon }: { name: string; icon?: string | null }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-background text-base"
    >
      {icon && icon !== failedIcon && WORKSPACE_AVATAR_PATTERN.test(icon) ? (
        <Image
          src={icon}
          alt=""
          width={32}
          height={32}
          unoptimized
          className="size-full object-cover"
          onError={() => setFailedIcon(icon)}
        />
      ) : (
        name[0]?.toUpperCase()
      )}
    </span>
  );
}
