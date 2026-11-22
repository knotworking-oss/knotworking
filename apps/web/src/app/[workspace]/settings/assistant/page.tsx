import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAssistantKeys, getAssistantSettings } from "@/lib/api";
import { KeysManager } from "./keys-manager";

export const metadata: Metadata = { title: "Assistant" };

export default async function AssistantSettingsPage() {
  const [{ keys }, { settings }] = await Promise.all([getAssistantKeys(), getAssistantSettings()]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Assistant</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <KeysManager keys={keys} settings={settings} />
      </div>
    </>
  );
}
