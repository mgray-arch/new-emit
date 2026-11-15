"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/shell";
import SoNumber from "@/components/so-number";
import { MessageComposer, MessageList } from "@/components/message-thread";
import { formatWhen } from "@/lib/dates";
import type { LoadOption, MessageView, ThreadLoadRef, ThreadSummary } from "@/lib/message-types";

const POLL_MS = 15_000;

function placeLabel(city: string, state: string): string {
  if (city && state) return `${city}, ${state}`;
  return city || state;
}

function laneLabel(load: ThreadLoadRef): string {
  const origin = placeLabel(load.originCity, load.originState);
  const destination = placeLabel(load.destinationCity, load.destinationState);
  if (origin && destination) return `${origin} → ${destination}`;
  return origin || destination;
}

function OptionLabel({ load }: { load: LoadOption }) {
  const lane = laneLabel({
    id: load.id,
    loadNumber: load.loadNumber,
    salesOrderNumber: load.salesOrderNumber,
    originCity: load.originCity,
    originState: load.originState,
    destinationCity: load.destinationCity,
    destinationState: load.destinationState,
    owner: null,
  });
  return (
    <>
      {`${load.loadNumber || "Pending"} · `}
      <SoNumber>{load.salesOrderNumber}</SoNumber>
      {lane ? ` · ${lane}` : ""}
    </>
  );
}

export default function MessagesPanel() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [openSummary, setOpenSummary] = useState<ThreadSummary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pinnedLoadId, setPinnedLoadId] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [formError, setFormError] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [accessKnown, setAccessKnown] = useState(false);
  const [chatOn, setChatOn] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [side, setSide] = useState<"" | "emit" | "select">("");
  const [showNew, setShowNew] = useState(false);
  const [loadId, setLoadId] = useState("");
  const [loadQuery, setLoadQuery] = useState("");
  const [loads, setLoads] = useState<LoadOption[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const thread = params.get("thread");
    const load = params.get("load");
    if (thread) setOpenId(thread);
    if (load) setPinnedLoadId(load);
  }, []);

  useEffect(() => {
    let cancel = false;
    fetch("/api/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((me: { readOnly?: boolean; chatEnabled?: boolean } | null) => {
        if (cancel) return;
        const next = Boolean(me?.readOnly);
        const enabled = Boolean(me?.chatEnabled);
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
    if (chatOn !== true || !showNew) return;
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
  }, [loadQuery, loadId, chatOn, showNew]);

  useEffect(() => {
    if (!accessKnown || chatOn !== true) {
      if (chatOn === false) setLoading(false);
      return;
    }
    let cancel = false;
    async function pullBoard() {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (unreadOnly) params.set("unread", "1");
      if (mineOnly) params.set("mine", "1");
      if (side) params.set("side", side);
      try {
        const response = await fetch(`/api/messages?${params}`);
        if (response.status === 403) {
          if (!cancel) {
            setChatOn(false);
            setLoading(false);
          }
          return;
        }
        if (!response.ok) {
          if (!cancel) setProblem("We couldn't load threads. Refresh the page and try again.");
          return;
        }
        const payload = (await response.json()) as { threads: ThreadSummary[] };
        if (cancel) return;
        setThreads(payload.threads);
        setProblem("");
      } catch {
        if (!cancel) setProblem("We couldn't load threads. Refresh the page and try again.");
      } finally {
        if (!cancel) setLoading(false);
      }
    }
    const timer = window.setTimeout(() => void pullBoard(), 200);
    const poll = window.setInterval(() => void pullBoard(), POLL_MS);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [accessKnown, chatOn, query, unreadOnly, mineOnly, side]);

  useEffect(() => {
    if (chatOn !== true) return;
    if (!openId && !pinnedLoadId) return;
    let cancel = false;
    async function pullThread() {
      const params = new URLSearchParams();
      if (openId) params.set("thread", openId);
      else if (pinnedLoadId) params.set("load", pinnedLoadId);
      try {
        const response = await fetch(`/api/messages?${params}`);
        if (!response.ok) return;
        const payload = (await response.json()) as { thread: ThreadSummary | null; messages: MessageView[] };
        if (cancel) return;
        setMessages(payload.messages);
        setOpenSummary(payload.thread);
        if (payload.thread) {
          setOpenId(payload.thread.id);
          if (!readOnly) {
            const marked = await fetch("/api/messages/read", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ threadId: payload.thread.id }),
            });
            if (marked.ok) window.dispatchEvent(new Event("emit-messages-read"));
          }
        }
      } catch {
        /* The board list still shows when one thread cannot be opened. */
      }
    }
    void pullThread();
    const poll = window.setInterval(() => void pullThread(), POLL_MS);
    return () => {
      cancel = true;
      window.clearInterval(poll);
    };
  }, [chatOn, openId, pinnedLoadId, readOnly]);

  useEffect(() => {
    if (!openId && !pinnedLoadId) return;
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
  }, [openId, pinnedLoadId]);

  async function send(target: { threadId?: string | null; loadId?: string | null }) {
    const text = body.trim();
    if (!text || sending || readOnly) return;
    setSending(true);
    setFormError("");
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: text, threadId: target.threadId || null, loadId: target.loadId || null }),
    });
    const payload = (await response.json().catch(() => null)) as { message?: MessageView; error?: string } | null;
    setSending(false);
    if (!response.ok || !payload?.message) {
      setFormError(payload?.error || "That message wasn't sent. Try again.");
      return;
    }
    setBody("");
    setShowNew(false);
    setOpenId(payload.message.threadId);
    setPinnedLoadId(payload.message.load?.id ?? target.loadId ?? null);
    setMessages((current) => {
      if (current.some((message) => message.id === payload.message!.id)) return current;
      if (openId && payload.message!.threadId !== openId) return [payload.message!];
      return [...current, payload.message!];
    });
    if (!readOnly && payload.message.threadId) {
      const marked = await fetch("/api/messages/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: payload.message.threadId }),
      });
      if (marked.ok) window.dispatchEvent(new Event("emit-messages-read"));
    }
  }

  function closeThread() {
    setOpenId(null);
    setPinnedLoadId(null);
    setOpenSummary(null);
    setMessages([]);
    setBody("");
    setFormError("");
    const url = new URL(window.location.href);
    url.searchParams.delete("thread");
    url.searchParams.delete("load");
    window.history.replaceState(null, "", url.pathname);
  }

  const openThread = openSummary ?? threads.find((thread) => thread.id === openId) ?? null;
  const threadOpen = Boolean(openId || pinnedLoadId);
  const selectedLoad = loads.find((load) => load.id === loadId) ?? null;

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
      <main className={threadOpen ? "page messages-page thread-open" : "page messages-page"}>
        <h1>Messages</h1>
        {threadOpen ? (
          <section className="thread-pane" aria-label="Thread">
            <button className="btn secondary thread-back" type="button" onClick={closeThread}>
              All threads
            </button>
            <ThreadHeading thread={openThread} />
            <div className="thread" role="log" aria-label="Replies">
              {messages.length === 0 ? <p className="empty">No replies yet. The first note starts this thread.</p> : null}
              <MessageList messages={messages} />
            </div>
            <MessageComposer
              body={body}
              setBody={setBody}
              sending={sending}
              error={formError}
              readOnly={readOnly}
              placeholder={openThread?.kind === "general" ? "Reply in General" : "Reply on this load"}
              onSubmit={() => void send({ threadId: openId, loadId: openId ? null : pinnedLoadId })}
            />
          </section>
        ) : (
          <>
            <p className="lede">
              Each load has one thread. Reply there and the load stays attached, so you do not type the load number again. Carrier
              pay and rate confirmations stay off these threads.
            </p>
            {problem ? <p className="warn">{problem}</p> : null}
            <div className="thread-tools">
              <input
                aria-label="Search threads"
                placeholder="Search SO, load, city, or reply"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="thread-filters" role="group" aria-label="Filter threads">
                <button type="button" aria-pressed={unreadOnly} title="Threads with replies you have not read" onClick={() => setUnreadOnly((on) => !on)}>
                  Unread
                </button>
                <button type="button" aria-pressed={mineOnly} title="Loads you own" onClick={() => setMineOnly((on) => !on)}>
                  My loads
                </button>
                <button
                  type="button"
                  aria-pressed={side === "emit"}
                  title="Latest reply is from EMIT"
                  onClick={() => setSide((current) => (current === "emit" ? "" : "emit"))}
                >
                  EMIT
                </button>
                <button
                  type="button"
                  aria-pressed={side === "select"}
                  title="Latest reply is from Select"
                  onClick={() => setSide((current) => (current === "select" ? "" : "select"))}
                >
                  Select
                </button>
              </div>
            </div>
            <div className="composer-actions thread-new-action">
              <button className="btn secondary" type="button" onClick={() => setShowNew((open) => !open)}>
                {showNew ? "Close" : "New message"}
              </button>
            </div>
            {showNew ? (
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send({ loadId: loadId || null });
                }}
              >
                <div className="load-picker">
                  <span className="label" id="load-picker-label">
                    Load
                  </span>
                  <button
                    type="button"
                    className="load-picker-toggle"
                    aria-expanded={pickerOpen}
                    aria-controls="load-picker-list"
                    aria-labelledby="load-picker-label"
                    onClick={() => setPickerOpen((open) => !open)}
                  >
                    <span>{selectedLoad ? <OptionLabel load={selectedLoad} /> : "General — not about one load"}</span>
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
                      <button type="button" className={loadId ? "load-picker-option" : "load-picker-option on"} onClick={() => { setLoadId(""); setPickerOpen(false); }}>
                        General — not about one load
                      </button>
                      {loads.map((load) => (
                        <button
                          key={load.id}
                          type="button"
                          className={load.id === loadId ? "load-picker-option on" : "load-picker-option"}
                          onClick={() => {
                            setLoadId(load.id);
                            setPickerOpen(false);
                          }}
                        >
                          <OptionLabel load={load} />
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
                    placeholder="Write the first note. Replies stay in this thread."
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                  />
                </label>
                {formError ? <p className="warn">{formError}</p> : null}
                <div className="composer-actions">
                  <button className="btn" type="submit" disabled={sending || !body.trim() || readOnly}>
                    {sending ? "Sending…" : "Send"}
                  </button>
                </div>
                {readOnly ? <p className="mini">View-as is read-only. Switch back to Select view to send a message.</p> : null}
              </form>
            ) : null}
            {loading ? <p className="mini">Loading threads…</p> : null}
            {!loading && threads.length === 0 ? (
              <p className="empty">
                {query || unreadOnly || mineOnly || side
                  ? "No threads match those filters."
                  : "No messages yet. Start one on a load, or write a general note."}
              </p>
            ) : null}
            <ul className="thread-board">
              {threads.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    className={thread.unread > 0 ? "thread-row unread" : "thread-row"}
                    onClick={() => {
                      setOpenSummary(thread);
                      setOpenId(thread.id);
                      setPinnedLoadId(thread.load?.id ?? null);
                      setMessages([]);
                      setFormError("");
                    }}
                  >
                    <span className="thread-row-top">
                      {thread.kind === "general" || !thread.load?.salesOrderNumber ? (
                        <strong>General</strong>
                      ) : (
                        <SoNumber>{thread.load.salesOrderNumber}</SoNumber>
                      )}
                      {thread.load ? <span>{thread.load.loadNumber ? `Load ${thread.load.loadNumber}` : "Load number pending"}</span> : null}
                      {thread.unread > 0 ? (
                        <span className="nav-count" aria-label={`${thread.unread} unread`}>
                          {thread.unread > 99 ? "99+" : thread.unread}
                        </span>
                      ) : null}
                    </span>
                    {thread.load ? (
                      <span className="thread-lane">
                        {laneLabel(thread.load) || "Lane not set"}
                        {` · Owner ${thread.load.owner || "unassigned"}`}
                      </span>
                    ) : (
                      <span className="thread-lane">Notes that are not about one load</span>
                    )}
                    <span className="thread-preview">
                      <span>
                        {thread.latest.authorName} · {thread.latest.side === "select" ? "Select" : "EMIT"} ·{" "}
                        <time dateTime={thread.latest.createdAt}>{formatWhen(thread.latest.createdAt)}</time>
                      </span>
                      <span className="thread-preview-text">{thread.latest.preview}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </Shell>
  );
}

function ThreadHeading({ thread }: { thread: ThreadSummary | null }) {
  if (!thread) return <p className="lede">This load does not have a note yet.</p>;
  if (thread.kind === "general" || !thread.load) {
    return <p className="lede">General. Notes that are not about one load.</p>;
  }
  const lane = laneLabel(thread.load);
  return (
    <p className="lede">
      <SoNumber>{thread.load.salesOrderNumber || "Load"}</SoNumber>
      {thread.load.loadNumber ? ` · Load ${thread.load.loadNumber}` : " · Load number pending"}
      {lane ? ` · ${lane}` : ""}
      {` · Owner ${thread.load.owner || "unassigned"}`}
    </p>
  );
}
