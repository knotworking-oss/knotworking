"use client";

import { Button } from "@knotworking/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@knotworking/ui/components/tooltip";
import { Kbd } from "@knotworking/ui/components/kbd";
import { Plus } from "lucide-react";
import { useWorkspace } from "@/lib/workspace-store";
import { useNewTask, type NewTaskDefaults } from "./new-task-dialog";

export function NewTaskButton({ defaults }: { defaults?: NewTaskDefaults }) {
  const { canEditTasks: canEdit } = useWorkspace();
  const newTask = useNewTask();
  if (!canEdit) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="sm" onClick={() => newTask(defaults)}>
          <Plus /> New task
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Create task <Kbd>C</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
