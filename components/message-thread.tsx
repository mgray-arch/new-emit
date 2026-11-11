"use client";

import Link from "next/link";
import { formatWhen } from "@/lib/dates";
import { splitMessageMentions, type MessageView } from "@/lib/message-types";

export function MessageText({ message }: { message: MessageView }) {
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

export function MessageList({ messages }: { messages: MessageView[] }) {
  return (
    <>
      {messages.map((message) => (
        <article key={message.id} className={message.mine ? "msg mine" : "msg"}>
          <div className="msg-meta">
            <span>
              {message.authorName} ({message.authorEmail}) · {message.side === "select" ? "Select" : "EMIT"}
            </span>
            <time dateTime={message.createdAt}>{formatWhen(message.createdAt)}</time>
          </div>
          <MessageText message={message} />
        </article>
      ))}
    </>
  );
}

export function MessageComposer({
  body,
  setBody,
  sending,
  error,
  readOnly,
  placeholder,
  onSubmit,
}: {
  body: string;
  setBody: (value: string) => void;
  sending: boolean;
  error: string;
  readOnly: boolean;
  placeholder: string;
  onSubmit: () => void;
}) {
  if (readOnly) {
    return <p className="mini">View-as is read-only. Switch back to Select view to send a message.</p>;
  }
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="field">
        <span>Reply</span>
        <textarea
          aria-label="Reply"
          maxLength={2000}
          placeholder={placeholder}
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
      {error ? <p className="warn">{error}</p> : null}
      <div className="composer-actions">
        <button className="btn" type="submit" disabled={sending || !body.trim()}>
          {sending ? "Sending…" : "Send reply"}
        </button>
      </div>
    </form>
  );
}
