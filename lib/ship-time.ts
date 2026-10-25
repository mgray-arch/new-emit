/**
 * Clock times for ship and delivery pickers.
 * The value is 24-hour HH:MM, which is what orders, SAM stop times, and
 * Denver timestamp conversion already store. A native time input cannot
 * force that display or a 30-minute step in every browser.
 */

/** Valid 24-hour HH:MM, any minute. Saved times from the old picker may use :01–:59. */
export const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function buildHalfHours(): string[] {
  const times: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const hh = String(hour).padStart(2, "0");
    times.push(`${hh}:00`, `${hh}:30`);
  }
  return times;
}

/** 00:00, 00:30, 01:00, … 23:30. */
export const HALF_HOUR_TIMES: readonly string[] = buildHalfHours();

/**
 * Options for a time dropdown. Half hours, plus a previously saved minute
 * so opening an older load does not blank the field or drop that time on save.
 */
export function timeSelectOptions(current: string): readonly string[] {
  const value = current.trim();
  if (!value || HALF_HOUR_TIMES.includes(value) || !HH_MM.test(value)) return HALF_HOUR_TIMES;
  return [...HALF_HOUR_TIMES, value].sort();
}
