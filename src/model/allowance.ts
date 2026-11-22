// Concern: an account's usage windows in plain words (GY-3499): how much is left, when it comes back, and the warning past 80%.
type Window = { window: string; percent: number; resetsAt: string | null };

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `at 09:20` later the same day, else `Sun 22 Nov 05:00` (UTC). */
export function backAt(iso: string, now: number) {
  const date = new Date(iso); iso = date.toISOString(); const clock = iso.slice(11, 16);
  return iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? `at ${clock}` : `${days[date.getUTCDay()]} ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${clock}`;
}

/** A window code in words: `5h` is `5-hour`, `7d` is `week`, `1d` is `day`; null for a name with no length. */
function span(window: string) {
  const match = /^(\d+)([mhd])$/.exec(window);
  if (!match) return null;
  const count = Number(match[1]), unit = match[2];
  if (unit === 'd' && count === 7) return 'week';
  if (unit === 'd' && count === 1) return 'day';
  return `${count}-${unit === 'd' ? 'day' : unit === 'h' ? 'hour' : 'minute'}`;
}

/** The window nearest its limit among those that have not reset yet. */
export function tightestWindow(usage: readonly Window[], now: number) {
  return usage.filter(entry => !entry.resetsAt || Date.parse(entry.resetsAt) > now)
    .reduce<Window | null>((tightest, entry) => !tightest || entry.percent > tightest.percent ? entry : tightest, null);
}

/** One sentence: `about 24% of this week left, back Sun 22 Nov 05:00`, or `allowance not reported`. */
export function allowanceSentence(usage: readonly Window[], now: number) {
  const window = tightestWindow(usage, now);
  if (!window) return 'allowance not reported';
  const left = Math.max(0, Math.round(100 - window.percent)), length = span(window.window);
  const of = length === 'week' ? 'this week' : length === 'day' ? 'today' : length ? `this ${length} window` : 'the allowance';
  return `${left ? `about ${left}%` : 'nothing'} of ${of} left${window.resetsAt ? `, back ${backAt(window.resetsAt, now)}` : ''}`;
}

/** The status row for an account with live sessions whose tightest window is at or past 80%; null otherwise. */
export function allowanceWarning(account: { name: string; usage: readonly Window[]; liveSessions: readonly unknown[] }, now: number) {
  const window = tightestWindow(account.usage, now);
  if (!account.liveSessions.length || !window || window.percent < 80) return null;
  const length = span(window.window), its = length === 'week' ? 'weekly' : length === 'day' ? 'daily' : length ?? '';
  return { subject: `account ${account.name}`, text: `${account.name} has used ${Math.round(window.percent)}% of its ${its ? `${its} ` : ''}allowance${window.resetsAt ? `; it is back ${backAt(window.resetsAt, now)}` : ''}`,
    next: 'the loop tries other accounts first' };
}
