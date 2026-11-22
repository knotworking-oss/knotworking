"use client";

import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { MentionChip } from "../mention-chip";
import { Mention } from "./mention";

/** The mention node with a live chip (current name, "unavailable" when the target is gone). */
export const MentionWithView = Mention.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MentionView);
  },
});

function MentionView({ node }: ReactNodeViewProps) {
  const { kind, id, label } = node.attrs as { kind: string; id: string; label: string };
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <MentionChip kind={kind} id={id} label={label} editing />
    </NodeViewWrapper>
  );
}
