import { useState } from 'react';

/**
 * GY-4066: the day-one checklist on Home for a new manager. One static panel with the copy below, each page
 * it names a link to that page. It shows while this browser has not dismissed it, remembered the way
 * web/theme.ts keeps the theme: a window with no storage (private mode) just shows it again.
 */
const KEY = 'graphyard.first-time-checklist';

/** Whether this browser dismissed the checklist. */
export function checklistDismissed(): boolean {
  try { return localStorage.getItem(KEY) !== null; } catch { return false; }
}
/** Got it: hide the checklist on this browser from now on. */
export function dismissChecklist() {
  try { localStorage.setItem(KEY, '1'); } catch { /* no storage: hidden on this page only */ }
}
/** Help's Show the first-time checklist: forget the dismissal, so Home shows it again. */
export function showChecklist() {
  try { localStorage.removeItem(KEY); } catch { /* nothing stored, nothing to forget */ }
}

export default function FirstTimeChecklist() {
  const [hidden, setHidden] = useState(checklistDismissed);
  if (hidden) return null;
  return <section className="panel first-time" aria-label="First time here?">
    <h2>First time here?</h2>
    <p>You set goals and answer what only you can. The Lead and its builders do the rest.</p>
    <ol>
      <li>Read the line at the top of <a href="#home">Home</a>. Moving is good; Slowed or Stopped shows a card with one button to press.</li>
      <li>Answer everything under <a href="#needs-you">Needs you</a>. Press Review request; the recommended answer comes first.</li>
      <li>Open <a href="#work">Work</a>. The header shows merges per hour and the median time from review to live.</li>
      <li>Press the Stuck filter on <a href="#work">Work</a>. For any change stuck there, ask the Lead why on the <a href="#lead">Lead</a> page.</li>
      <li>Open <a href="#lead">Lead</a>, then <a href="#product">Product</a>. Check the product brief says what you want built.</li>
      <li>Type one goal with a number into Tell the Lead below, then press Send.</li>
      <li>Use your app for ten minutes and tell the Lead what felt wrong.</li>
    </ol>
    <p>The full guide is in Settings → <a href="#guide">Help</a>.</p>
    <button type="button" onClick={() => { dismissChecklist(); setHidden(true); }}>Got it</button>
  </section>;
}
