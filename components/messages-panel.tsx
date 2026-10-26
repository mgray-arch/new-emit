"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Shell from "@/components/shell";
import { formatWhen } from "@/lib/dates";
import { splitMessageMentions, type LoadOption, type MessageLoadRef, type MessageView } from "@/lib/message-types";

const POLL_MS = 15_000;

function loadLabel(load: MessageLoadRef): string {
  const number = load.loadNumber ? `Load ${load.loadNumber}` : load.salesOrderNumber || "Load";
  const so = load.loadNumber && load.salesOrderNumber ? ` · ${load.salesOrderNumber}` : "";
  const lane =
    load.originCity && load.destinationCity
      ? ` · ${load.originCity}, ${load.originState} → ${load.destinationCity}, ${load.destinationState}`
      : "";
  return `${number}${so}${lane}`;
}

function optionLabel(load: LoadOption): string {
  const number = load.loadNumber || "Pending";
  return `${number} · ${load.salesOrderNumber} · ${load.originCity}, ${load.originState} → ${load.destinationCity}, ${load.destinationState}`;
}

function mergeMessages(current: MessageView[], incoming: MessageView[]): MessageView[] {
  const byId = new Map<string, MessageView>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.seq - right.seq);
}

function MessageText({ message }: { message: MessageView }) {
  const parts = splitMessageMentions(message.body, message.mentions);
  return (
    <p className="msg-body">
      {parts.map((part, index) =>
        part.orderId ? (
          <Link key={`${part.orderId}-${index}`} href={`/orders/${part.orderId}`} className="text-link">
            {part.text}
          </Link>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

export default function MessagesPanel() {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [problem, setProblem] = useState("");
  const [formError, setFormError] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [accessKnown, setAccessKnown] = useState(false);
  const [loadId, setLoadId] = useState("");
  const [loadQuery, setLoadQuery] = useState("");
  const [loads, setLoads] = useState<LoadOption[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chatOn, setChatOn] = useState<boolean | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const readOnlyRef = useRef(false);
  const markReadRef = useRef(false);
  const seeded = useRef(false);
  const newest = messages[messages.length - 1]?.seq ?? 0;

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("load");
    if (id) setLoadId(id);
  }, []);

  useEffect(() => {
    let cancel = false;
    fetch("/api/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((me: { readOnly?: boolean; chatEnabled?: boolean } | null) => {
        if (cancel) return;
        const next = Boolean(me?.readOnly);
        const enabled = Boolean(me?.chatEnabled);
        readOnlyRef.current = next;
        markReadRef.current = Boolean(me) && enabled && !next;
        setReadOnly(next);
        setChatOn(me ? enabled : null);
        setAccessKnown(true);
      })
      .catch(() => {
        if (!cancel) setAccessKnown(true);
      });
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (chatOn !== true) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (loadQuery.trim()) params.set("q", loadQuery.trim());
      if (loadId) params.set("include", loadId);
      fetch(`/api/messages/loads?${params}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { loads?: LoadOption[] } | null) => {
          if (payload?.loads) setLoads(payload.loads);
        })
        .catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [loadQuery, loadId, chatOn]);

  useEffect(() => {
    let cancel = false;
    async function pull() {
      try {
        const response = await fetch("/api/messages");
        if (response.status === 403) {
          if (!cancel) {
            setChatOn(false);
            setLoading(false);
          }
          return;
        }
        if (!response.ok) {
          if (!cancel) setProblem("We couldn't load messages. Refresh the page and try again.");
          return;
        }
        const payload = (await response.json()) as { messages: MessageView[]; hasMore: boolean };
        if (cancel) return;
        setMessages((current) => mergeMessages(current, payload.messages));
        if (!seeded.current) {
          setHasMore(payload.hasMore);
          seeded.current = true;
        }
        setProblem("");
        if (markReadRef.current) {
          const marked = await fetch("/api/messages/read", { method: "POST" });
          if (marked.ok) window.dispatchEvent(new Event("emit-messages-read"));
        }
      } catch {
        if (!cancel) setProblem("We couldn't load messages. Refresh the page and try again.");
      } finally {
        if (!cancel) setLoading(false);
      }
    }
    if (!accessKnown || chatOn !== true) {
      if (chatOn === false && !cancel) setLoading(false);
      return;
    }
    void pull();
    const timer = window.setInterval(() => void pull(), POLL_MS);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [accessKnown, chatOn]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [newest]);

  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    if (!viewport) return;
    function sync() {
      const current = window.visualViewport;
      if (!current) return;
      const keyboard = Math.max(0, window.innerHeight - current.height - current.offsetTop);
      root.style.setProperty("--vv-height", `${current.height}px`);
      root.style.setProperty("--vv-offset", `${current.offsetTop}px`);
      root.style.setProperty("--keyboard-inset", `${keyboard}px`);
    }
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      window.removeEventListener("orientationchange", sync);
      root.style.removeProperty("--vv-height");
      root.style.removeProperty("--vv-offset");
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);

  async function loadEarlier() {
    const oldest = messages[0];
    if (!oldest) return;
    const response = await fetch(`/api/messages?beforeSeq=${oldest.seq}`);
    if (!response.ok) return;
    const payload = (await response.json()) as { messages: MessageView[]; hasMore: boolean };
    setMessages((current) => mergeMessages(current, payload.messages));
    setHasMore(payload.hasMore);
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (!text || sending || readOnly) return;
    setSending(true);
    setFormError("");
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: text, loadId: loadId || null }),
    });
    const payload = (await response.json().catch(() => null)) as { message?: MessageView; error?: string } | null;
    setSending(false);
    if (!response.ok || !payload?.message) {
      setFormError(payload?.error || "That message wasn't sent. Try again.");
      return;
    }
    setBody("");
    setMessages((current) => mergeMessages(current, [payload.message!]));
    if (markReadRef.current) {
      const marked = await fetch("/api/messages/read", { method: "POST" });
      if (marked.ok) window.dispatchEvent(new Event("emit-messages-read"));
    }
  }

  const selectedLoad = loads.find((load) => load.id === loadId) ?? null;

  function chooseLoad(id: string) {
    setLoadId(id);
    setPickerOpen(false);
  }

  if (chatOn === false) {
    return (
      <Shell>
        <main className="page">
          <h1>Messages</h1>
          <p className="empty">Chat is turned off for this account. Ask Select to enable it.</p>
        </main>
      </Shell>
    );
  }

  return (
    <Shell>
      <main className="page messages-page">
        <h1>Messages</h1>
        <p className="lede">
          One thread for EMIT and Select. Pick a load or type its number. People reply here. The assistant does not. Carrier
          pay and rate confirmations stay off this thread.
        </p>
        {problem ? <p className="warn">{problem}</p> : null}
        <div className="thread" ref={scroller} role="log" aria-label="Messages">
          {hasMore ? (
            <button className="btn secondary" type="button" onClick={() => void loadEarlier()}>
              Earlier messages
            </button>
          ) : null}
          {loading ? <p className="mini">Loading messages…</p> : null}
          {!loading && messages.length === 0 ? (
            <p className="empty">No messages yet. Write the note here. Add a load if it is about one.</p>
          ) : null}
          {messages.map((message) => (
            <article key={message.id} className={message.mine ? "msg mine" : "msg"}>
              <div className="msg-meta">
                <span>
                  {message.authorName} ({message.authorEmail}) · {message.side === "select" ? "Select" : "EMIT"}
                </span>
                <time dateTime={message.createdAt}>{formatWhen(message.createdAt)}</time>
              </div>
              <MessageText message={message} />
              {message.load ? (
                <div className="msg-load">
                  {message.load.id ? (
                    <Link href={`/orders/${message.load.id}`} className="text-link">
                      {loadLabel(message.load)}
                    </Link>
                  ) : (
                    <span>{loadLabel(message.load)}</span>
                  )}
                </div>
              ) : null}
            </article>
          ))}
        </div>
        {readOnly ? (
          <p className="mini">View-as is read-only. Switch back to Select view to send a message.</p>
        ) : (
          <form className="composer" onSubmit={(event) => void send(event)}>
            <div className="load-picker">
              <span className="label" id="load-picker-label">
                Load, if this is about one
              </span>
              <button
                type="button"
                className="load-picker-toggle"
                aria-expanded={pickerOpen}
                aria-controls="load-picker-list"
                aria-labelledby="load-picker-label"
                onClick={() => setPickerOpen((open) => !open)}
              >
                <span>{selectedLoad ? optionLabel(selectedLoad) : loadId ? "Selected load" : "No specific load"}</span>
                <span className="load-picker-action">{pickerOpen ? "Close" : "Choose"}</span>
              </button>
              {pickerOpen ? (
                <div id="load-picker-list" className="load-picker-panel">
                  <input
                    aria-label="Search loads"
                    placeholder="Search load number, SO, or city"
                    value={loadQuery}
                    onChange={(event) => setLoadQuery(event.target.value)}
                  />
                  <button type="button" className={loadId ? "load-picker-option" : "load-picker-option on"} onClick={() => chooseLoad("")}>
                    No specific load
                  </button>
                  {loads.map((load) => (
                    <button
                      key={load.id}
                      type="button"
                      className={load.id === loadId ? "load-picker-option on" : "load-picker-option"}
                      onClick={() => chooseLoad(load.id)}
                    >
                      {optionLabel(load)}
                    </button>
                  ))}
                  {loads.length === 0 ? <p className="mini">No loads match that search.</p> : null}
                </div>
              ) : null}
            </div>
            <label className="field">
              <span>Message</span>
              <textarea
                aria-label="Message"
                maxLength={2000}
                placeholder="Write to EMIT and Select."
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            </label>
            {formError ? <p className="warn">{formError}</p> : null}
            <div className="composer-actions">
              <button className="btn" type="submit" disabled={sending || !body.trim()}>
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        )}
      </main>
    </Shell>
  );
}
