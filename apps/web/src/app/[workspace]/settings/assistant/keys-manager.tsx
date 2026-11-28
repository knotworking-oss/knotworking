"use client";

import {
  ASSISTANT_DEFAULT_MODULES,
  ASSISTANT_NO_TOOL_MODULES,
  assistantProviderNames,
  assistantProviders,
  moduleList,
  type AssistantProvider,
  type ModuleId,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@knotworking/ui/components/radio-group";
import { Spinner } from "@knotworking/ui/components/spinner";
import { KeyRound, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { AssistantKey, AssistantSettings } from "@/lib/api";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { relativeTime } from "@/lib/relative-time";

/**
 * Settings → Assistant: the member's own provider API keys, the model each provider uses, and what
 * the assistant may do. Keys are checked with the provider when saved and are never shown again.
 */
export function KeysManager({ keys, settings }: { keys: AssistantKey[]; settings: AssistantSettings }) {
  const router = useRouter();
  const [removing, setRemoving] = useState<AssistantProvider | null>(null);
  const keyFor = (provider: AssistantProvider) => keys.find((k) => k.provider === provider);

  const updateSettings = async (json: {
    scope?: "read" | "write";
    defaultProvider?: AssistantProvider | null;
    modules?: ModuleId[] | null;
  }) => {
    try {
      await unwrap(browserApi().v1.me.assistant.settings.$patch({ json }));
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <Card>
        <CardHeader>
          <CardTitle>Your API keys</CardTitle>
          <CardDescription>
            The assistant uses a model through your own account, so usage is billed to you by the provider. A
            key is checked with the provider when you save it, stored encrypted on this server, used only for
            your own chats, and never shown again.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ul>
            {assistantProviders.map((provider) => (
              <ProviderRow
                key={provider}
                provider={provider}
                saved={keyFor(provider)}
                isDefault={settings.defaultProvider === provider}
                onChanged={() => router.refresh()}
                onMakeDefault={() => updateSettings({ defaultProvider: provider })}
                onRemove={() => setRemoving(provider)}
              />
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What the assistant may do</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <RadioGroup
                value={settings.scope}
                onValueChange={(v) => void updateSettings({ scope: v as "read" | "write" })}
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="write" id="scope-write" />
                  <Label htmlFor="scope-write">Read and change things, as you</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="read" id="scope-read" />
                  <Label htmlFor="scope-read">Only look things up</Label>
                </div>
              </RadioGroup>
              <FieldDescription>
                Either way it can't do anything you can't, and sign-offs and approvals always need you.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <ToolsCard
        modules={settings.modules as ModuleId[]}
        isDefault={settings.modulesAreDefault}
        onSave={(modules) => updateSettings({ modules })}
      />

      <RemoveDialog
        provider={removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        onRemoved={() => router.refresh()}
      />
    </div>
  );
}

/** Which modules' tools the assistant is given. Fewer is cheaper and faster, and OpenAI accepts at most 128. */
function ToolsCard({
  modules,
  isDefault,
  onSave,
}: {
  modules: ModuleId[];
  isDefault: boolean;
  onSave: (modules: ModuleId[] | null) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<ModuleId[]>(modules);
  const [pending, setPending] = useState(false);
  const choices = moduleList.filter((m) => !ASSISTANT_NO_TOOL_MODULES.includes(m.id));
  const same = chosen.length === modules.length && chosen.every((m) => modules.includes(m));
  const toggle = (id: ModuleId, on: boolean) =>
    setChosen((list) => (on ? [...list, id] : list.filter((m) => m !== id)));
  const save = async (value: ModuleId[] | null) => {
    setPending(true);
    await onSave(value);
    if (value === null) setChosen([...ASSISTANT_DEFAULT_MODULES]);
    setPending(false);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tools it can use</CardTitle>
        <CardDescription>
          Choose the parts of Knotworking the assistant can work in. Every tool is sent to the model on every
          message, so a short list is faster and cheaper, and OpenAI refuses more than 128. It only ever
          reaches modules you have access to.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {choices.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <Checkbox
                id={`tool-module-${m.id}`}
                checked={chosen.includes(m.id)}
                onCheckedChange={(v) => toggle(m.id, v === true)}
              />
              <Label htmlFor={`tool-module-${m.id}`} className="font-normal">
                {m.name}
              </Label>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button disabled={pending || same || chosen.length === 0} onClick={() => void save(chosen)}>
            {pending && <Spinner />} Save
          </Button>
          {!isDefault && (
            <Button variant="ghost" disabled={pending} onClick={() => void save(null)}>
              Back to the everyday set
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderRow({
  provider,
  saved,
  isDefault,
  onChanged,
  onMakeDefault,
  onRemove,
}: {
  provider: AssistantProvider;
  saved: AssistantKey | undefined;
  isDefault: boolean;
  onChanged: () => void;
  onMakeDefault: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const name = assistantProviderNames[provider];

  const loadModels = async () => {
    if (models || !saved) return;
    try {
      const res = await unwrap(
        browserApi().v1.me.assistant.keys[":provider"].models.$get({ param: { provider } }),
      );
      setModels(res.models);
    } catch {
      setModels([]); // the model can still be typed in
    }
  };

  return (
    <li className="flex flex-col gap-3 border-b px-6 py-4 last:border-b-0">
      <div className="flex items-center gap-3">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            {saved ? (
              <Badge variant="secondary" className="font-mono">
                …{saved.last4}
              </Badge>
            ) : (
              <Badge variant="outline">No key</Badge>
            )}
            {isDefault && <Badge>Default</Badge>}
          </div>
          {saved && (
            <span className="text-xs text-muted-foreground">Saved {relativeTime(saved.updatedAt)}</span>
          )}
        </div>
        {saved && !isDefault && (
          <Button variant="ghost" size="sm" onClick={onMakeDefault}>
            Make default
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
          {saved ? "Replace key" : "Add key"}
        </Button>
        {saved && (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${name} key`} onClick={onRemove}>
            <Trash2 />
          </Button>
        )}
      </div>

      {editing && (
        <KeyForm
          provider={provider}
          onSaved={(savedModels) => {
            setModels(savedModels);
            setEditing(false);
            onChanged();
          }}
        />
      )}

      {saved && (
        <ModelField
          provider={provider}
          current={saved.model}
          models={models}
          onFocus={() => void loadModels()}
          onSaved={onChanged}
        />
      )}
    </li>
  );
}

function KeyForm({
  provider,
  onSaved,
}: {
  provider: AssistantProvider;
  onSaved: (models: string[]) => void;
}) {
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      const res = await unwrap(
        browserApi().v1.me.assistant.keys[":provider"].$put({
          param: { provider },
          json: { key: key.trim() },
        }),
      );
      toast.success(`${assistantProviderNames[provider]} key saved`);
      setKey("");
      onSaved(res.models);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <Field className="flex-1">
        <FieldLabel htmlFor={`key-${provider}`}>API key</FieldLabel>
        <Input
          id={`key-${provider}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Paste your key"
          required
        />
      </Field>
      <Button type="submit" disabled={pending || key.trim().length < 8}>
        {pending && <Spinner />} Check and save
      </Button>
    </form>
  );
}

/** The model new chats on this provider use: pick from the provider's list, or type any model id. */
function ModelField({
  provider,
  current,
  models,
  onFocus,
  onSaved,
}: {
  provider: AssistantProvider;
  current: string | null;
  models: string[] | null;
  onFocus: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(current ?? "");
  const [pending, setPending] = useState(false);
  const listId = `models-${provider}`;
  const dirty = value.trim() !== (current ?? "");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.me.assistant.keys[":provider"].$patch({
          param: { provider },
          json: { model: value.trim() || null },
        }),
      );
      toast.success("Model saved");
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={save} className="flex items-end gap-2">
      <Field className="flex-1">
        <FieldLabel htmlFor={`model-${provider}`}>Model for new chats</FieldLabel>
        <Input
          id={`model-${provider}`}
          list={listId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={onFocus}
          placeholder="Pick one, or type a model id"
          maxLength={200}
        />
        <datalist id={listId}>
          {(models ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Field>
      <Button type="submit" variant="outline" disabled={pending || !dirty}>
        {pending && <Spinner />} Save
      </Button>
    </form>
  );
}

function RemoveDialog({
  provider,
  onOpenChange,
  onRemoved,
}: {
  provider: AssistantProvider | null;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const [pending, setPending] = useState(false);
  const remove = async () => {
    if (!provider) return;
    setPending(true);
    try {
      await unwrapEmpty(browserApi().v1.me.assistant.keys[":provider"].$delete({ param: { provider } }));
      toast.success(`Removed your ${assistantProviderNames[provider]} key`);
      onOpenChange(false);
      onRemoved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={provider !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove your {provider ? assistantProviderNames[provider] : ""} key?</DialogTitle>
          <DialogDescription>
            It is deleted from this server. Chats that used it can be read but not continued until you add a
            key again or switch them to another provider.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" onClick={remove} disabled={pending}>
            {pending && <Spinner />} Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
