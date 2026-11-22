"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@knotworking/ui/components/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@knotworking/ui/components/popover";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Switch } from "@knotworking/ui/components/switch";
import { Textarea } from "@knotworking/ui/components/textarea";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { Check, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { addDays, isoDate, isoTime, localDateToUtc, parseIsoDate } from "@/lib/calendar-dates";
import { providerName, videoName, type CalendarConnection, type Meeting, type Member } from "./types";

export interface MeetingDraft {
  meeting?: Meeting;
  start: Date;
  end: Date;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function MeetingDialog({
  draft,
  slug,
  members,
  connections,
  onClose,
}: {
  draft: MeetingDraft | null;
  slug: string;
  members: Member[];
  connections: CalendarConnection[];
  onClose: () => void;
}) {
  const router = useRouter();
  const editing = draft?.meeting;
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [attendees, setAttendees] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [video, setVideo] = useState(false);
  const [notes, setNotes] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!draft) return;
    const m = draft.meeting;
    setTitle(m?.title ?? "");
    setDate(isoDate(draft.start));
    setStartTime(isoTime(draft.start));
    setEndTime(isoTime(draft.end));
    setAllDay(m?.allDay ?? false);
    setAttendees(m ? m.attendees.filter((a) => !a.isOrganizer).map((a) => a.email) : []);
    setLocation(m?.location ?? "");
    setDescription(m?.description ?? "");
    setVideo(m?.addVideoCall ?? false);
    setNotes(true);
    setError(null);
  }, [draft]);

  const connection = editing
    ? connections.find((c) => c.provider === editing.provider)
    : (connections.find((c) => c.status === "active") ?? connections[0]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const day = parseIsoDate(date);
    if (!day) return setError("Pick a date");
    // All-day meetings are dates: sent as UTC midnight so they land on the same day everywhere.
    const startsAt = allDay ? localDateToUtc(day) : new Date(`${date}T${startTime}`);
    const endsAt = allDay ? localDateToUtc(addDays(day, 1)) : new Date(`${date}T${endTime}`);
    if (endsAt <= startsAt) return setError("The meeting must end after it starts");
    setPending(true);
    setError(null);
    const body = {
      title,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      allDay,
      attendeeEmails: attendees,
      location: location || null,
      description: description || null,
      addVideoCall: video,
    };
    try {
      const api = browserApi().v1.workspaces[":slug"].meetings;
      const saved = editing
        ? await unwrap(api[":id"].$patch({ param: { slug, id: editing.id }, json: body }))
        : await unwrap(api.$post({ param: { slug }, json: { ...body, createNotes: notes } }));
      if (saved.syncState === "error")
        toast.warning(`Saved in Knotworking, but couldn't update your calendar: ${saved.syncError}`);
      else if (saved.syncState === "synced")
        toast.success(
          `${editing ? "Updated" : "Added"} in ${providerName[saved.provider!]}${attendees.length ? " · invitations sent" : ""}`,
        );
      else toast.success(editing ? "Meeting updated" : "Meeting created");
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={draft !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit meeting" : "New meeting"}</DialogTitle>
            <DialogDescription>
              {connection
                ? `Saved to your ${providerName[connection.provider]}; invitations are sent to attendees.`
                : "Connect a calendar to send invitations. Without one, the meeting is visible in Knotworking only."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="m-title">Title</FieldLabel>
              <Input
                id="m-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Sprint planning"
                required
                autoFocus
              />
            </Field>
            <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
              <Field>
                <FieldLabel htmlFor="m-date">Date</FieldLabel>
                <Input
                  id="m-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </Field>
              {!allDay && (
                <>
                  <Field>
                    <FieldLabel htmlFor="m-start">Start</FieldLabel>
                    <Input
                      id="m-start"
                      type="time"
                      step={300}
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="m-end">End</FieldLabel>
                    <Input
                      id="m-end"
                      type="time"
                      step={300}
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      required
                    />
                  </Field>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Switch id="m-allday" checked={allDay} onCheckedChange={setAllDay} />
              <Label htmlFor="m-allday">All day</Label>
            </div>
            <Field>
              <FieldLabel>Attendees</FieldLabel>
              <AttendeePicker members={members} value={attendees} onChange={setAttendees} />
            </Field>
            <Field>
              <FieldLabel htmlFor="m-location">Location</FieldLabel>
              <Input
                id="m-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Room, address or link"
              />
            </Field>
            {connection && (
              <div className="flex items-center gap-2">
                <Switch id="m-video" checked={video} onCheckedChange={setVideo} />
                <Label htmlFor="m-video">Add a {videoName[connection.provider]} link</Label>
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="m-desc">Description</FieldLabel>
              <Textarea
                id="m-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </Field>
            {!editing && (
              <div className="flex items-center gap-2">
                <Checkbox id="m-notes" checked={notes} onCheckedChange={(v) => setNotes(v === true)} />
                <Label htmlFor="m-notes">Create a meeting notes doc</Label>
              </div>
            )}
            {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />} {editing ? "Save changes" : "Create meeting"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AttendeePicker({
  members,
  value,
  onChange,
}: {
  members: Member[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const toggle = (email: string) =>
    onChange(value.includes(email) ? value.filter((e) => e !== email) : [...value, email]);
  const byEmail = new Map(members.map((m) => [m.email, m]));
  const typedEmail =
    EMAIL.test(query.trim()) && !value.includes(query.trim().toLowerCase())
      ? query.trim().toLowerCase()
      : null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((email) => {
        const m = byEmail.get(email);
        return (
          <Badge key={email} variant="secondary" className="h-6 gap-1 pr-1 pl-1">
            {m ? <UserAvatar name={m.name} className="size-4" /> : null}
            {m?.name ?? email}
            <button
              type="button"
              aria-label={`Remove ${m?.name ?? email}`}
              onClick={() => toggle(email)}
              className="rounded-sm opacity-60 hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </Badge>
        );
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="xs">
            <Plus /> Add people
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Name or email address…" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>Type a full email address to invite someone outside Knotworking.</CommandEmpty>
              {typedEmail && (
                <CommandGroup heading="Guest">
                  <CommandItem
                    value={typedEmail}
                    onSelect={() => {
                      toggle(typedEmail);
                      setQuery("");
                    }}
                  >
                    <Plus /> Invite {typedEmail}
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup heading="Members">
                {members.map((m) => (
                  <CommandItem key={m.id} value={`${m.name} ${m.email}`} onSelect={() => toggle(m.email)}>
                    <UserAvatar name={m.name} className="size-5" />
                    <span className="flex-1 truncate">{m.name}</span>
                    {value.includes(m.email) && <Check className="size-4" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
