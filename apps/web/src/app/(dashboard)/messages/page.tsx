import type { Metadata } from "next";
import { MessagesPage } from "@/components/messaging/messages-page";

export const metadata: Metadata = { title: "Messages" };

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) || null;

/** `/messages?c=<conversation>&m=<message>` opens a conversation at a message. */
export default async function MessagesRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  return (
    <MessagesPage
      key={first(query.c) ?? "messages"}
      initialConversationId={first(query.c)}
      initialMessageId={first(query.m)}
    />
  );
}
