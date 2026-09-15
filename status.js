import { addDays, daysBetween } from './dates.js?v=3';

// Club status ladder — «Клубные статусы и правила абонементов.pdf».
// Computed from the user's own check-ins and purchases; lessons taken with a bonus count as lessons.
// Not counted yet: single visits, the 1 000 ₽ fee, demotion after 3 months without visits.
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
const UPGRADE_EVENTS = 24;

// Dates strictly after `since` (in the current level) and within [from, to].
const countIn = (dates, since, from, to) => dates.filter((d) => d > since && d >= from && d <= to).length;

// The first day the next level is earned: a year in the current level and, within the last year,
// 12 subscriptions or 24 events bought/visited in the current level.
function upgradeDate(since, subDates, eventDates, now) {
  const earliest = addDays(since, YEAR);
  const candidates = [...new Set([earliest, ...subDates, ...eventDates])]
    .filter((d) => d >= earliest && d <= now)
    .sort();
  return (
    candidates.find((d) => {
      const from = addDays(d, -YEAR);
      return (
        countIn(subDates, since, from, d) >= UPGRADE_SUBS || countIn(eventDates, since, from, d) >= UPGRADE_EVENTS
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
  const lessonDates = subs.flatMap((s) => [...s.visits, ...(s.bonusVisits || []).map((b) => b.date)]).sort();
  const eventDates = events.map((e) => e.date).sort();
  const subDates = subs.map((s) => s.bought).sort();

  let level = 0;
  let since = [lessonDates[RED_LESSONS - 1], eventDates[RED_EVENTS - 1]].filter(Boolean).sort()[0] || null;
  const history = []; // [{ id, since }] — every level reached, in order
  if (since) {
    level = 1;
    history.push({ id: LEVELS[level].id, since });
    while (level < LEVELS.length - 1) {
      const next = upgradeDate(since, subDates, eventDates, now);
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
      progress: Math.min(1, Math.max(lessonDates.length / RED_LESSONS, eventDates.length / RED_EVENTS)),
    };
  } else if (level < LEVELS.length - 1) {
    const from = addDays(now, -YEAR);
    const subsYear = countIn(subDates, since, from, now);
    const eventsYear = countIn(eventDates, since, from, now);
    result.next = {
      name: LEVELS[level + 1].name,
      subsLeft: Math.max(0, UPGRADE_SUBS - subsYear),
      eventsLeft: Math.max(0, UPGRADE_EVENTS - eventsYear),
      yearFrom: addDays(since, YEAR), // a year in the current level is reached on this day
      progress: Math.min(
        1,
        daysBetween(since, now) / YEAR,
        Math.max(subsYear / UPGRADE_SUBS, eventsYear / UPGRADE_EVENTS),
      ),
    };
  }
  return result;
}
