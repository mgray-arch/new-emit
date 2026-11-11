"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MessageComposer, MessageList } from "@/components/message-thread";
import type { MessageView, ThreadSummary } from "@/lib/message-types";

const POLL_MS = 15_000;

export default function LoadThread({ loadId, readOnly }: { loadId: string; readOnly: boolean }) {
  const [thread, setThread] = useState<ThreadSummary | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [problem, setProblem] = useState("");
  const [formError, setFormError] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    async function pull() {
      try {
        const response = await fetch(`/api/messages?load=${encodeURIComponent(loadId)}`);
        if (response.status === 403) {
          if (!cancel) {
            setProblem("Chat is turned off for this account.");
            setLoading(false);
          }
          return;
        }
        if (!response.ok) {
          if (!cancel) setProblem("We couldn't load this thread. Refresh the page and try again.");
          return;
        }
        const payload = (await response.json()) as { thread: ThreadSummary | null; messages: MessageView[] };
        if (cancel) return;
        setThread(payload.thread);
        setMessages(payload.messages);
        setProblem("");
        if (payload.thread && !readOnly) {
          const marked = await fetch("/api/messages/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId: payload.thread.id }),
          });
          if (marked.ok) window.dispatchEvent(new Event("emit-messages-read"));
        }
      } catch {
        if (!cancel) setProblem("We couldn't load this thread. Refresh the page and try again.");
      } finally {
        if (!cancel) setLoading(false);
      }
    }
    void pull();
    const timer = window.setInterval(() => void pull(), POLL_MS);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [loadId, readOnly]);

  async function send() {
    const text = body.trim();
    if (!text || sending || readOnly) return;
    setSending(true);
    setFormError("");
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(thread ? { body: text, threadId: thread.id } : { body: text, loadId }),
    });
    const payload = (await response.json().catch(() => null)) as { message?: MessageView; error?: string } | null;
    setSending(false);
    if (!response.ok || !payload?.message) {
      setFormError(payload?.error || "That reply wasn't sent. Try again.");
      return;
    }
    setBody("");
    setMessages((current) => {
      if (current.some((message) => message.id === payload.message!.id)) return current;
      return [...current, payload.message!];
    });
    if (payload.message.threadId) {
      setThread((current) =>
        current ?? {
          id: payload.message!.threadId,
          kind: "load",
          load: null,
          latest: {
            id: payload.message!.id,
            preview: payload.message!.body,
            authorName: payload.message!.authorName,
            side: payload.message!.side,
            createdAt: payload.message!.createdAt,
            mine: true,
          },
          unread: 0,
          messageCount: 1,
        },
      );
      if (!readOnly) {
        const marked = await fetch("/api/messages/read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: payload.message.threadId }),
        });
        if (marked.ok) window.dispatchEvent(new Event("emit-messages-read"));
      }
    }
  }

  return (
    <section className="load-thread" aria-label="Load thread">
      <div className="thread-row-top">
        <h2>Thread</h2>
        <Link href={`/messages?load=${encodeURIComponent(loadId)}`} className="text-link">
          Open on the board
        </Link>
      </div>
      <p className="mini">Replies stay on this load. You do not need to type the load number again.</p>
      {problem ? <p className="warn">{problem}</p> : null}
      <div className="thread" role="log" aria-label="Replies">
        {loading ? <p className="mini">Loading thread…</p> : null}
        {!loading && messages.length === 0 ? <p className="empty">No notes on this load yet. The first one starts the thread.</p> : null}
        <MessageList messages={messages} />
      </div>
      {problem ? null : (
        <MessageComposer
          body={body}
          setBody={setBody}
          sending={sending}
          error={formError}
          readOnly={readOnly}
          placeholder="Reply on this load"
          onSubmit={() => void send()}
        />
      )}
    </section>
  );
}
