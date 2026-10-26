import { formatDay, formatWhen } from "@/lib/dates";
import { redactSensitiveText } from "@/lib/sensitive";
import type { StopSchedule } from "@/lib/types";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;
const ZONE = /\s+(?:MDT|MST|PDT|PST|CDT|CST|EDT|EST|UTC)$/i;

/** Calendar date from YYYY-MM-DD or from a SAM date-only value serialized at 12:00Z. The date is not shifted. */
export function calendarDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DATE_ONLY.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Local wall-clock HH:MM. Accepts 16:30, 1630, and a trailing timezone abbreviation that is already local. */
export function clockTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(ZONE, "");
  if (!trimmed) return null;
  let hour: number;
  let minute: number;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  const compact = /^(\d{3,4})$/.exec(trimmed);
  if (hm) {
    hour = Number(hm[1]);
    minute = Number(hm[2]);
  } else if (compact) {
    const padded = compact[1].padStart(4, "0");
    hour = Number(padded.slice(0, 2));
    minute = Number(padded.slice(2));
  } else {
    return null;
  }
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function appointmentWindow(value: unknown): { start: string | null; end: string | null; text: string | null } {
  if (typeof value !== "string") return { start: null, end: null, text: null };
  const cleaned = value.trim();
  if (!cleaned) return { start: null, end: null, text: null };
  const ranged = cleaned.split(/\s*(?:-|–|—|\bto\b)\s*/i).filter(Boolean);
  if (ranged.length === 2) {
    const start = clockTime(ranged[0]);
    const end = clockTime(ranged[1]);
    if (start && end) return { start, end, text: null };
  }
  const pair = /^(\d{3,4}|\d{1,2}:\d{2})\s+(\d{3,4}|\d{1,2}:\d{2})(?:\s+[A-Za-z]{2,4})?$/.exec(cleaned);
  if (pair) {
    const start = clockTime(pair[1]);
    const end = clockTime(pair[2]);
    if (start && end) return { start, end, text: null };
  }
  const start = clockTime(cleaned);
  if (start) return { start, end: null, text: null };
  const text = redactSensitiveText(cleaned).slice(0, 80);
  return { start: null, end: null, text: text || null };
}

/** Keep an arrival or departure timestamp as sent. A value that is not a timestamp is dropped. */
export function keptInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return trimmed;
}

export function sanitizeSchedule(value: unknown): StopSchedule | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const schedule: StopSchedule = {
    date: calendarDate(row.date),
    appointmentStart: clockTime(row.appointmentStart),
    appointmentEnd: clockTime(row.appointmentEnd),
    appointmentText:
      typeof row.appointmentText === "string" ? redactSensitiveText(row.appointmentText).slice(0, 80) || null : null,
    arrivedAt: keptInstant(row.arrivedAt),
    departedAt: keptInstant(row.departedAt),
  };
  if (!schedule.date && !schedule.appointmentStart && !schedule.appointmentEnd && !schedule.appointmentText && !schedule.arrivedAt && !schedule.departedAt) {
    return null;
  }
  return schedule;
}

export function formatStopSchedule(schedule: StopSchedule | null | undefined): string {
  if (!schedule) return "";
  const window =
    schedule.appointmentStart && schedule.appointmentEnd
      ? `${schedule.appointmentStart}–${schedule.appointmentEnd}`
      : schedule.appointmentStart || schedule.appointmentText || "";
  const arrived = schedule.arrivedAt ? `Arrived ${formatWhen(schedule.arrivedAt)}` : "";
  const departed = schedule.departedAt ? `Departed ${formatWhen(schedule.departedAt)}` : "";
  return [schedule.date ? formatDay(schedule.date) : "", window, arrived, departed].filter(Boolean).join(" · ");
}
