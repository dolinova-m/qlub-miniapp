import { addDays } from './dates.js?v=4';
import { isSubscription, levelOn } from './status.js?v=4';

// Bonus lessons — «Клубная система.md»: added to every purchased subscription (not to single or trial lessons)
// by the status on the purchase day, valid 90 days, not tied to a direction, spent oldest first.
export const BONUS_BY_LEVEL = { guest: 0, red: 1, gold: 2, diamond: 2, black: 0 };
export const BONUS_VALID_DAYS = 90;

export function bonusOf(sub, history) {
  const total = isSubscription(sub) ? BONUS_BY_LEVEL[levelOn(history, sub.bought)] : 0;
  const used = (sub.bonusVisits || []).length;
  return { total, used, left: Math.max(0, total - used), until: addDays(sub.bought, BONUS_VALID_DAYS) };
}

export const bonusAlive = (bonus, now) => bonus.left > 0 && now <= bonus.until;

// The subscription whose bonus is spent next: the oldest one with a bonus still alive.
export function bonusSource(subs, history, now) {
  return (
    [...subs]
      .sort((a, b) => a.bought.localeCompare(b.bought) || a.id.localeCompare(b.id))
      .find((s) => bonusAlive(bonusOf(s, history), now)) || null
  );
}

export function availableBonuses(subs, history, now) {
  let count = 0;
  let until = null;
  for (const sub of subs) {
    const bonus = bonusOf(sub, history);
    if (!bonusAlive(bonus, now)) continue;
    count += bonus.left;
    if (!until || bonus.until < until) until = bonus.until;
  }
  return { count, until };
}
