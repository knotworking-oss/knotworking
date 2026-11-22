import {
  d,
  sortKeysBetween,
  type DocContent,
  type TagColorName,
  type WorkflowStateType,
} from "@knotworking/core";
import { eq } from "drizzle-orm";
import { createPasswordUser } from "./accounts";
import type { Database } from "./client";
import {
  documents,
  taskLabels,
  meetingAttendees,
  meetings,
  tasks,
  labels,
  projects,
  projectTeams,
  teamMembers,
  teams,
  workflowStates,
  workspaceMembers,
  workspaces,
} from "./schema";

const WORKSPACE_SLUG = "acme";

/** Password for every seeded demo account. Development/demo data only. */
export const DEMO_PASSWORD = "knotworking-demo";

/** Idempotent demo data: a small business with Marketing, Operations and Sales teams, projects, tasks, docs and meetings. */
export async function seed(db: Database): Promise<{ skipped: boolean; workspaceSlug: string }> {
  const existing = await db.select().from(workspaces).where(eq(workspaces.slug, WORKSPACE_SLUG));
  if (existing.length) return { skipped: true, workspaceSlug: WORKSPACE_SLUG };

  await db.transaction(async (tx) => {
    // ── People ──
    // Every demo account signs in with DEMO_PASSWORD. Ada is the workspace owner.
    const people = [];
    for (const [email, name] of [
      ["ada@knotworking.dev", "Ada Park"],
      ["marcus@knotworking.dev", "Marcus Chen"],
      ["priya@knotworking.dev", "Priya Raman"],
      ["tomas@knotworking.dev", "Tomás Silva"],
      ["noor@knotworking.dev", "Noor Haddad"],
    ] as const) {
      people.push(await createPasswordUser(tx, { email, name, password: DEMO_PASSWORD }));
    }
    const [ada, marcus, priya, tomas, noor] = people as [
      (typeof people)[0],
      (typeof people)[0],
      (typeof people)[0],
      (typeof people)[0],
      (typeof people)[0],
    ];

    const [ws] = await tx
      .insert(workspaces)
      .values({ slug: WORKSPACE_SLUG, name: "Acme Inc", icon: "🏢" })
      .returning();
    const workspaceId = ws!.id;

    await tx.insert(workspaceMembers).values(
      people.map((u, i) => ({
        workspaceId,
        userId: u.id,
        role: i === 0 ? ("owner" as const) : ("member" as const),
      })),
    );

    // ── Teams & workflows ──
    const teamRows = await tx
      .insert(teams)
      .values([
        { workspaceId, key: "MKT", name: "Marketing", icon: "📣", color: "orange" as const },
        { workspaceId, key: "OPS", name: "Operations", icon: "🧰", color: "teal" as const },
        { workspaceId, key: "SAL", name: "Sales", icon: "💼", color: "blue" as const },
      ])
      .returning();
    const [mkt, ops, sal] = teamRows as [(typeof teamRows)[0], (typeof teamRows)[0], (typeof teamRows)[0]];

    const membership: [typeof mkt, (typeof people)[number][]][] = [
      [mkt, [ada, priya, noor]],
      [ops, [ada, tomas, noor]],
      [sal, [ada, marcus, priya]],
    ];
    await tx
      .insert(teamMembers)
      .values(
        membership.flatMap(([team, members]) =>
          members.map((u) => ({ workspaceId, teamId: team.id, userId: u.id })),
        ),
      );

    const workflow: [string, WorkflowStateType][] = [
      ["Backlog", "backlog"],
      ["Todo", "unstarted"],
      ["In Progress", "started"],
      ["In Review", "started"],
      ["Done", "completed"],
      ["Canceled", "canceled"],
    ];
    const stateKeys = sortKeysBetween(null, null, workflow.length);
    const states = new Map<string, Map<string, string>>(); // teamId → name → stateId
    for (const team of teamRows) {
      const rows = await tx
        .insert(workflowStates)
        .values(
          workflow.map(([name, type], i) => ({
            workspaceId,
            teamId: team.id,
            name,
            type,
            sortOrder: stateKeys[i]!,
          })),
        )
        .returning();
      states.set(team.id, new Map(rows.map((r) => [r.name, r.id])));
    }

    // ── Labels ──
    const labelDefs: [string, TagColorName][] = [
      ["Client request", "red"],
      ["Content", "purple"],
      ["Event", "pink"],
      ["Finance", "green"],
      ["Hiring", "teal"],
      ["Admin", "gray"],
      ["Idea", "yellow"],
    ];
    const labelRows = await tx
      .insert(labels)
      .values(labelDefs.map(([name, color]) => ({ workspaceId, name, color })))
      .returning();
    const label = (name: string) => labelRows.find((l) => l.name === name)!.id;

    // Dates are relative to when the demo is seeded, so it always looks current.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const day = (offset: number) =>
      new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

    // ── Projects ──
    const projectKeys = sortKeysBetween(null, null, 4);
    const projectRows = await tx
      .insert(projects)
      .values([
        {
          workspaceId,
          name: "Winter product launch",
          icon: "🚀",
          color: "purple" as const,
          status: "active" as const,
          health: "on_track" as const,
          leadId: priya.id,
          startDate: day(-24),
          targetDate: day(60),
          description: "Announce the new product line to customers, partners and press in January.",
          sortOrder: projectKeys[0]!,
        },
        {
          workspaceId,
          name: "Team offsite",
          icon: "🏔️",
          color: "teal" as const,
          status: "active" as const,
          health: "at_risk" as const,
          leadId: tomas.id,
          startDate: day(-18),
          targetDate: day(95),
          description: "Two days together in February: planning, workshops and a team dinner.",
          sortOrder: projectKeys[1]!,
        },
        {
          workspaceId,
          name: "Website refresh",
          icon: "🌐",
          color: "blue" as const,
          status: "planned" as const,
          health: null,
          leadId: noor.id,
          startDate: day(23),
          targetDate: day(110),
          description: "New homepage, updated brand colours and customer stories front and centre.",
          sortOrder: projectKeys[2]!,
        },
        {
          workspaceId,
          name: "Customer survey",
          icon: "📊",
          color: "orange" as const,
          status: "completed" as const,
          health: "on_track" as const,
          leadId: marcus.id,
          startDate: day(-100),
          targetDate: day(-30),
          completedAt: new Date(today.getTime() - 32 * 86_400_000),
          description: "Ask every customer how we're doing and share what we learned.",
          sortOrder: projectKeys[3]!,
        },
      ])
      .returning();
    const [pLaunch, pOffsite, pWebsite, pSurvey] = projectRows as [
      (typeof projectRows)[0],
      (typeof projectRows)[0],
      (typeof projectRows)[0],
      (typeof projectRows)[0],
    ];
    await tx.insert(projectTeams).values([
      { workspaceId, projectId: pLaunch.id, teamId: mkt.id },
      { workspaceId, projectId: pLaunch.id, teamId: sal.id },
      { workspaceId, projectId: pOffsite.id, teamId: ops.id },
      { workspaceId, projectId: pWebsite.id, teamId: mkt.id },
      { workspaceId, projectId: pSurvey.id, teamId: sal.id },
      { workspaceId, projectId: pSurvey.id, teamId: mkt.id },
    ]);

    // ── Tasks ──
    type TaskSeed = {
      team: typeof mkt;
      title: string;
      state: string;
      priority: 0 | 1 | 2 | 3 | 4;
      assignee?: typeof ada;
      project?: typeof pLaunch;
      labels?: string[];
      /** Days from today; negative is overdue. */
      due?: number;
      description?: DocContent;
      /** Title of the parent task (seeded earlier in the list). */
      parent?: string;
    };
    const taskSeeds: TaskSeed[] = [
      // Marketing
      {
        team: mkt,
        title: "Draft January newsletter",
        state: "In Progress",
        priority: 2,
        assignee: priya,
        project: pLaunch,
        labels: ["Content"],
        due: 3,
        description: d.doc(
          d.p("Our first newsletter of the year doubles as the launch teaser."),
          d.h(3, "Sections"),
          d.bullets(
            "A note from Ada",
            "Sneak peek of the new product line",
            "Customer story",
            "Upcoming events",
          ),
        ),
      },
      {
        team: mkt,
        title: "Design launch announcement graphics",
        state: "In Review",
        priority: 2,
        assignee: noor,
        project: pLaunch,
        labels: ["Content"],
        due: 5,
      },
      {
        team: mkt,
        title: "Write launch blog post",
        state: "Todo",
        priority: 2,
        assignee: priya,
        project: pLaunch,
        labels: ["Content"],
        due: 10,
      },
      {
        team: mkt,
        title: "Plan December social media calendar",
        state: "Todo",
        priority: 3,
        assignee: noor,
        labels: ["Content"],
        due: 14,
      },
      {
        team: mkt,
        title: "Collect customer testimonials for the website",
        state: "Backlog",
        priority: 3,
        project: pWebsite,
        labels: ["Content"],
      },
      {
        team: mkt,
        title: "Update brand guidelines with the new colours",
        state: "Backlog",
        priority: 4,
        assignee: noor,
        project: pWebsite,
        labels: ["Idea"],
      },
      {
        team: mkt,
        title: "Publish October case study",
        state: "Done",
        priority: 3,
        assignee: priya,
        labels: ["Content"],
      },
      {
        team: mkt,
        title: "Sponsor the regional trade fair",
        state: "Canceled",
        priority: 4,
        labels: ["Event"],
      },

      // Operations
      {
        team: ops,
        title: "Book venue for the team offsite",
        state: "In Progress",
        priority: 1,
        assignee: tomas,
        project: pOffsite,
        labels: ["Event"],
        due: 2,
        description: d.doc(
          d.p(
            "We need space for 25 people over two days, with a room for workshops and somewhere for dinner.",
          ),
          d.h(3, "Shortlist"),
          d.tasks(
            ["Lakeside Lodge: quote received", true],
            ["The Old Mill: visit on Thursday", false],
            ["City conference centre: waiting to hear back", false],
          ),
        ),
      },
      {
        team: ops,
        title: "Collect dietary requirements for the offsite",
        state: "Todo",
        priority: 3,
        assignee: tomas,
        project: pOffsite,
        labels: ["Event"],
        due: 12,
      },
      {
        team: ops,
        title: "Arrange travel for the offsite",
        state: "Backlog",
        priority: 2,
        project: pOffsite,
        labels: ["Event"],
      },
      {
        team: ops,
        title: "Renew office insurance policy",
        state: "Todo",
        priority: 1,
        assignee: ada,
        labels: ["Finance"],
        due: -2,
      },
      {
        team: ops,
        title: "Approve November expense reports",
        state: "In Review",
        priority: 2,
        assignee: ada,
        labels: ["Finance"],
        due: 1,
      },
      {
        team: ops,
        title: "Onboard our new office manager",
        state: "In Progress",
        priority: 2,
        assignee: ada,
        labels: ["Hiring"],
        due: 6,
      },
      {
        team: ops,
        title: "Order laptop and set up accounts",
        state: "Done",
        priority: 2,
        assignee: tomas,
        parent: "Onboard our new office manager",
      },
      {
        team: ops,
        title: "Schedule a welcome lunch",
        state: "Todo",
        priority: 3,
        assignee: noor,
        due: 5,
        parent: "Onboard our new office manager",
      },
      {
        team: ops,
        title: "Compare payroll providers",
        state: "Backlog",
        priority: 3,
        labels: ["Finance", "Idea"],
      },
      {
        team: ops,
        title: "Set up a shared team calendar",
        state: "Done",
        priority: 3,
        assignee: tomas,
        labels: ["Admin"],
      },

      // Sales
      {
        team: sal,
        title: "Prepare proposal for Northwind Traders",
        state: "In Progress",
        priority: 1,
        assignee: marcus,
        labels: ["Client request"],
        due: 4,
        description: d.doc(
          d.p("Northwind wants a year-long contract for their three stores, starting in March."),
          d.h(3, "To include"),
          d.bullets("Pricing for 12 and 24 months", "Onboarding timeline", "Two reference customers"),
        ),
      },
      {
        team: sal,
        title: "Follow up with leads from the trade show",
        state: "Todo",
        priority: 2,
        assignee: marcus,
        due: 7,
      },
      {
        team: sal,
        title: "Update the pricing sheet for next year",
        state: "In Review",
        priority: 2,
        assignee: marcus,
        project: pLaunch,
        labels: ["Finance"],
        due: 9,
      },
      {
        team: sal,
        title: "Quarterly review with Globex",
        state: "Todo",
        priority: 2,
        assignee: priya,
        labels: ["Client request"],
        due: 15,
      },
      {
        team: sal,
        title: "Clean up duplicate contacts in the CRM",
        state: "Backlog",
        priority: 4,
        labels: ["Admin"],
      },
      {
        team: sal,
        title: "Analyse survey responses",
        state: "Done",
        priority: 2,
        assignee: priya,
        project: pSurvey,
      },
      {
        team: sal,
        title: "Share survey results with the team",
        state: "Done",
        priority: 3,
        assignee: marcus,
        project: pSurvey,
      },
    ];

    const taskKeys = sortKeysBetween(null, null, taskSeeds.length);
    const now = Date.now();
    const taskIds = new Map<string, string>();
    for (const [i, s] of taskSeeds.entries()) {
      const stateId = states.get(s.team.id)!.get(s.state)!;
      const type = workflow.find(([n]) => n === s.state)![1];
      const at = new Date(now - (taskSeeds.length - i) * 3_600_000 * 7);
      const [row] = await tx
        .insert(tasks)
        .values({
          workspaceId,
          teamId: s.team.id,
          title: s.title,
          description: s.description ?? null,
          stateId,
          priority: s.priority,
          assigneeId: s.assignee?.id ?? null,
          creatorId: ada.id,
          projectId: s.project?.id ?? null,
          parentId: s.parent ? taskIds.get(s.parent)! : null,
          dueDate: s.due === undefined ? null : day(s.due),
          sortOrder: taskKeys[i]!,
          startedAt: type === "started" || type === "completed" ? at : null,
          completedAt: type === "completed" ? at : null,
          canceledAt: type === "canceled" ? at : null,
          createdAt: at,
          updatedAt: at,
        })
        .returning({ id: tasks.id });
      taskIds.set(s.title, row!.id);
      if (s.labels?.length) {
        await tx
          .insert(taskLabels)
          .values(s.labels.map((l) => ({ workspaceId, taskId: row!.id, labelId: label(l) })));
      }
    }

    // ── Docs (wiki) ──
    const topKeys = sortKeysBetween(null, null, 4);
    const [handbook, brand, notes, plan] = await tx
      .insert(documents)
      .values([
        {
          workspaceId,
          title: "Team Handbook",
          icon: "📘",
          sortOrder: topKeys[0]!,
          creatorId: ada.id,
          lastEditedById: tomas.id,
          teamId: ops.id,
          content: d.doc(
            d.p(
              "Everything you need to know about working at Acme. New here? Start with the new starter checklist, then read the expense policy.",
            ),
            d.callout("💡", "This handbook is a living document. If something is wrong or missing, fix it."),
            d.h(2, "How we work"),
            d.numbered(
              "Write it down: plans, decisions and notes live in Knotworking",
              "Every task has one owner and a due date",
              "Default to open: share early, ask for help often",
            ),
          ),
        },
        {
          workspaceId,
          title: "Brand Guidelines",
          icon: "✨",
          sortOrder: topKeys[1]!,
          creatorId: noor.id,
          lastEditedById: noor.id,
          teamId: mkt.id,
          content: d.doc(
            d.p(
              "Acme should sound ",
              d.text("clear", "bold"),
              ", ",
              d.text("warm", "bold"),
              " and ",
              d.text("confident", "bold"),
              ".",
            ),
            d.h(2, "Voice"),
            d.p("Write like you talk to a customer you like. Short sentences, plain words, no jargon."),
            d.h(2, "Logo and colours"),
            d.p(
              "Use the full-colour logo on light backgrounds and the white logo on photos or dark backgrounds.",
            ),
            d.h(2, "Photography"),
            d.p("Real people, natural light, our actual offices and customers. Avoid stock photos."),
            d.quote("Say less, mean more."),
          ),
        },
        {
          workspaceId,
          title: "Meeting Notes",
          icon: "🗓️",
          sortOrder: topKeys[2]!,
          creatorId: ada.id,
          lastEditedById: ada.id,
          content: d.doc(d.p("Weekly team meetings, reviews and planning notes.")),
        },
        {
          workspaceId,
          title: "Plan for Next Year",
          icon: "🧭",
          sortOrder: topKeys[3]!,
          creatorId: ada.id,
          lastEditedById: priya.id,
          content: d.doc(
            d.h(2, "Now"),
            d.tasks(["Winter product launch", false], ["Team offsite", false], ["Customer survey", true]),
            d.h(2, "Next"),
            d.bullets("Website refresh", "Open a second office", "Customer referral programme"),
            d.h(2, "Later"),
            d.bullets("Partner programme", "Expand to two new regions", "Annual customer conference"),
          ),
        },
      ])
      .returning();

    const childKeys = sortKeysBetween(null, null, 2);
    await tx.insert(documents).values([
      {
        workspaceId,
        parentId: handbook!.id,
        title: "New Starter Checklist",
        icon: "🧭",
        sortOrder: childKeys[0]!,
        creatorId: ada.id,
        lastEditedById: ada.id,
        content: d.doc(
          d.p("Welcome to Acme! Work through this list in your first week."),
          d.h(2, "First day"),
          d.tasks(
            ["Collect your laptop and set up your accounts", false],
            ["Meet your buddy for coffee", false],
            ["Join the weekly team meeting", false],
          ),
          d.h(2, "First week"),
          d.tasks(
            ["Read the brand guidelines", false],
            ["Shadow a customer call", false],
            ["Pick up your first task", false],
          ),
        ),
      },
      {
        workspaceId,
        parentId: handbook!.id,
        title: "Expense Policy",
        icon: "💳",
        sortOrder: childKeys[1]!,
        creatorId: ada.id,
        lastEditedById: ada.id,
        content: d.doc(
          d.callout("⚠️", "Submit expenses within 30 days, with a photo of the receipt."),
          d.h(2, "What you can claim"),
          d.bullets(
            "Travel to customers and events",
            "Meals with customers, up to $60 a person",
            "Books and courses (ask your manager first)",
          ),
          d.h(2, "How to claim"),
          d.numbered(
            "Add the expense in the finance tool",
            "Attach the receipt",
            "Your manager approves it each month",
          ),
        ),
      },
      {
        workspaceId,
        parentId: notes!.id,
        title: "Weekly Team Meeting",
        icon: "📝",
        sortOrder: childKeys[0]!,
        creatorId: ada.id,
        lastEditedById: ada.id,
        content: d.doc(
          d.h(3, "Attendees"),
          d.p("Ada, Marcus, Priya, Tomás, Noor"),
          d.h(3, "Notes"),
          d.bullets(
            "Offsite is at risk: the first-choice venue is booked, two options left",
            "Northwind proposal due this week; pricing sheet in review",
            "Launch graphics are in review, newsletter draft on track",
          ),
          d.h(3, "Action items"),
          d.tasks(
            ["Tomás: book the offsite venue", false],
            ["Marcus: send the Northwind proposal", false],
            ["Ada: renew the office insurance", false],
          ),
        ),
      },
    ]);
    void brand;
    void plan;

    // ── Meetings (this week, Knotworking-only until someone connects a calendar) ──
    const weekly = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.title, "Weekly Team Meeting"));
    const monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const at = (day: number, hour: number, minutes = 0) =>
      new Date(monday.getTime() + day * 86_400_000 + (hour * 60 + minutes) * 60_000);
    const meetingSeeds = [
      {
        title: "Weekly team meeting",
        day: 0,
        from: [10, 0],
        to: [10, 30],
        organizer: ada,
        with: [marcus, priya, tomas, noor],
        doc: weekly[0]?.id,
      },
      {
        title: "Northwind proposal review",
        day: 1,
        from: [14, 0],
        to: [15, 0],
        organizer: marcus,
        with: [ada, priya],
      },
      {
        title: "Launch content review",
        day: 2,
        from: [11, 0],
        to: [12, 0],
        organizer: priya,
        with: [noor, ada],
        location: "Meeting room 2",
      },
      {
        title: "Offsite planning",
        day: 3,
        from: [15, 30],
        to: [16, 15],
        organizer: tomas,
        with: [ada, noor],
      },
      {
        title: "Monthly finance check-in",
        day: 4,
        from: [9, 30],
        to: [10, 30],
        organizer: ada,
        with: [marcus, tomas],
      },
    ];
    for (const m of meetingSeeds) {
      const [row] = await tx
        .insert(meetings)
        .values({
          workspaceId,
          title: m.title,
          location: m.location ?? null,
          startsAt: at(m.day, m.from[0]!, m.from[1]),
          endsAt: at(m.day, m.to[0]!, m.to[1]),
          organizerId: m.organizer.id,
          documentId: m.doc ?? null,
        })
        .returning();
      await tx.insert(meetingAttendees).values([
        {
          workspaceId,
          meetingId: row!.id,
          userId: m.organizer.id,
          email: m.organizer.email,
          name: m.organizer.name,
          isOrganizer: true,
          response: "accepted" as const,
        },
        ...m.with.map((u, i) => ({
          workspaceId,
          meetingId: row!.id,
          userId: u.id,
          email: u.email,
          name: u.name,
          response: (["accepted", "accepted", "tentative", "needsAction"] as const)[i % 4],
        })),
      ]);
    }
  });

  return { skipped: false, workspaceSlug: WORKSPACE_SLUG };
}
