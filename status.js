import { addDays, daysBetween } from './dates.js?v=5';

// Club status ladder — «Клубные статусы и правила абонементов.pdf».
// Computed from the user's own check-ins and purchases; single, trial and bonus lessons count as lessons.
// Not counted yet: the 1 000 ₽ fee, demotion after 3 months without visits.
// Lessons and events are separate paths, not summed (open question).
export const LEVELS = [
  { id: 'guest', name: 'Гость' },
  { id: 'red', name: 'Red' },
  { id: 'gold', name: 'Gold' },
  { id: 'diamond', name: 'Diamond' },
  { id: 'black', name: 'Black' },
];

const RED_LESSONS = 16;
const RED_EVENTS = 10;
const YEAR = 365;
const UPGRADE_SUBS = 12;
const UPGRADE_SINGLES = 50;
const UPGRADE_EVENTS = 24;

// Records without `kind` were saved before single and trial lessons existed — they are subscriptions.
export const isSubscription = (record) => !record.kind || record.kind === 'subscription';

// Dates strictly after `since` (in the current level) and within [from, to].
const countIn = (dates, since, from, to) => dates.filter((d) => d > since && d >= from && d <= to).length;

// The first day the next level is earned: a year in the current level and, within the last year,
// 12 subscriptions, 50 single lessons or 24 events bought/visited in the current level.
function upgradeDate(since, paths, now) {
  const earliest = addDays(since, YEAR);
  const candidates = [...new Set([earliest, ...paths.subs, ...paths.singles, ...paths.events])]
    .filter((d) => d >= earliest && d <= now)
    .sort();
  return (
    candidates.find((d) => {
      const from = addDays(d, -YEAR);
      return (
        countIn(paths.subs, since, from, d) >= UPGRADE_SUBS ||
        countIn(paths.singles, since, from, d) >= UPGRADE_SINGLES ||
        countIn(paths.events, since, from, d) >= UPGRADE_EVENTS
      );
    }) || null
  );
}

// Level id on a given day, from clubStatus().history.
export function levelOn(history, date) {
  let id = LEVELS[0].id;
  for (const step of history) if (step.since <= date) id = step.id;
  return id;
}

export function clubStatus(subs, events, now) {
  // A bonus given to a friend is the friend's lesson, not the owner's — it does not count here.
  const lessonDates = subs
    .flatMap((s) => [...s.visits, ...(s.bonusVisits || []).filter((b) => !b.friend).map((b) => b.date)])
    .sort();
  const eventDates = events.map((e) => e.date).sort();
  const paths = {
    subs: subs.filter(isSubscription).map((s) => s.bought).sort(),
    singles: subs.filter((s) => s.kind === 'single').flatMap((s) => s.visits).sort(),
    events: eventDates,
  };

  let level = 0;
  let since = [lessonDates[RED_LESSONS - 1], eventDates[RED_EVENTS - 1]].filter(Boolean).sort()[0] || null;
  const history = []; // [{ id, since }] — every level reached, in order
  if (since) {
    level = 1;
    history.push({ id: LEVELS[level].id, since });
    while (level < LEVELS.length - 1) {
      const next = upgradeDate(since, paths, now);
      if (!next) break;
      level += 1;
      since = next;
      history.push({ id: LEVELS[level].id, since });
    }
  }

  const result = {
    level: LEVELS[level],
    since,
    history,
    lessons: lessonDates.length,
    events: eventDates.length,
    next: null,
  };

  if (level === 0) {
    result.next = {
      name: LEVELS[1].name,
      lessonsLeft: Math.max(0, RED_LESSONS - lessonDates.length),
      eventsLeft: Math.max(0, RED_EVENTS - eventDates.length),
      // Every path to the next level — the home screen shows the closest one.
      paths: [
        { id: 'lessons', left: Math.max(0, RED_LESSONS - lessonDates.length), total: RED_LESSONS },
        { id: 'events', left: Math.max(0, RED_EVENTS - eventDates.length), total: RED_EVENTS },
      ],
      progress: Math.min(1, Math.max(lessonDates.length / RED_LESSONS, eventDates.length / RED_EVENTS)),
    };
  } else if (level < LEVELS.length - 1) {
    const from = addDays(now, -YEAR);
    const subsYear = countIn(paths.subs, since, from, now);
    const singlesYear = countIn(paths.singles, since, from, now);
    const eventsYear = countIn(paths.events, since, from, now);
    result.next = {
      name: LEVELS[level + 1].name,
      subsLeft: Math.max(0, UPGRADE_SUBS - subsYear),
      singlesLeft: Math.max(0, UPGRADE_SINGLES - singlesYear),
      eventsLeft: Math.max(0, UPGRADE_EVENTS - eventsYear),
      paths: [
        { id: 'subs', left: Math.max(0, UPGRADE_SUBS - subsYear), total: UPGRADE_SUBS },
        { id: 'singles', left: Math.max(0, UPGRADE_SINGLES - singlesYear), total: UPGRADE_SINGLES },
        { id: 'events', left: Math.max(0, UPGRADE_EVENTS - eventsYear), total: UPGRADE_EVENTS },
      ],
      yearFrom: addDays(since, YEAR), // a year in the current level is reached on this day
      progress: Math.min(
        1,
        daysBetween(since, now) / YEAR,
        Math.max(subsYear / UPGRADE_SUBS, singlesYear / UPGRADE_SINGLES, eventsYear / UPGRADE_EVENTS),
      ),
    };
  }
  return result;
}
