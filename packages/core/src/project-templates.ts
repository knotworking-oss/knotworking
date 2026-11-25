import { z } from "zod";

export const projectTemplateIds = ["employee_onboarding", "client_kickoff"] as const;

export const projectTemplates = {
  employee_onboarding: {
    label: "Employee onboarding",
    dateLabel: "Employee start date",
    tasks: [
      { title: "Prepare equipment and workspace", daysFromStart: -7 },
      { title: "Set up accounts and access", daysFromStart: -3 },
      { title: "Send the first-day agenda", daysFromStart: -1 },
      { title: "Introduce the team and review key policies", daysFromStart: 0 },
      { title: "Schedule role training", daysFromStart: 3 },
      { title: "Hold the first-week check-in", daysFromStart: 7 },
    ],
  },
  client_kickoff: {
    label: "Client kickoff",
    dateLabel: "Kickoff date",
    tasks: [
      { title: "Confirm scope, contacts and responsibilities", daysFromStart: -5 },
      { title: "Share the kickoff agenda", daysFromStart: -2 },
      { title: "Hold the kickoff meeting", daysFromStart: 0 },
      { title: "Send decisions and next actions", daysFromStart: 1 },
      { title: "Confirm milestones and review dates", daysFromStart: 3 },
    ],
  },
} satisfies Record<
  (typeof projectTemplateIds)[number],
  {
    label: string;
    dateLabel: string;
    tasks: { title: string; daysFromStart: number }[];
  }
>;

export const projectFromTemplateSchema = z.object({
  commandId: z.uuid(),
  templateId: z.enum(projectTemplateIds),
  name: z.string().trim().min(1).max(256),
  teamId: z.uuid(),
  leadId: z.uuid(),
  startDate: z.iso
    .date()
    .refine((date) => date >= "0002-01-01" && date < "9999-01-01", "Choose a supported start date"),
});
export type ProjectFromTemplateInput = z.infer<typeof projectFromTemplateSchema>;
