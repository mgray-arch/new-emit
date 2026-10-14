"use client";

import { useState } from "react";
import Shell from "@/components/shell";
import type { AssistantAnswer } from "@/lib/types";

const SUGGESTIONS = ["What delivers this week?", "What's in transit?", "What's booked?"];

interface Turn {
  role: "user" | "assistant";
  text: string;
  answer?: AssistantAnswer;
}

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setQuestion("");
    setTurns((current) => [...current, { role: "user", text: trimmed }]);
    setPending(true);
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: trimmed }),
    });
    const answer = (await response.json()) as AssistantAnswer;
    setTurns((current) => [...current, { role: "assistant", text: answer.text || "No answer", answer }]);
    setPending(false);
  }

  return (
    <Shell>
      <main className="page">
        <h1>ASK ABOUT AN SO</h1>
        <p className="lede">Questions are answered from your shipments only. Carrier pay is not in this assistant.</p>
        <div className="chips">
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => ask(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
        <div className="chat" style={{ marginTop: 16 }}>
          {turns.map((turn, index) => (
            <div className={`bubble ${turn.role}`} key={index}>
              {turn.text}
              {turn.answer?.references?.length ? (
                <div className="refs">
                  {turn.answer.references.map((ref) => (
                    <a key={ref.loadNumber + ref.salesOrderNumber} href={ref.trackingUrl}>
                      {ref.salesOrderNumber} · load {ref.loadNumber} · {ref.originCity} to {ref.destinationCity}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          <form
            className="ask-form"
            onSubmit={(event) => {
              event.preventDefault();
              void ask(question);
            }}
          >
            <input
              aria-label="Question"
              placeholder="Where is my sales order?"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <button className="btn" type="submit" disabled={pending}>
              {pending ? "Looking…" : "Ask"}
            </button>
          </form>
        </div>
      </main>
    </Shell>
  );
}
