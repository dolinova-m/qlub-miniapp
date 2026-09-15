import { DIRECTIONS, DAYS_BY_SIZE, PAY_PHONE, PAY_RECIPIENT } from './catalog.js?v=3';
import { today, addDays, short, full } from './dates.js?v=3';
import { clubStatus } from './status.js?v=3';
import { BONUS_BY_LEVEL, bonusOf, bonusAlive, bonusSource, availableBonuses } from './bonuses.js?v=3';
import * as store from './store.js?v=3';

const VERSION = 3;
const tg = window.Telegram?.WebApp;
const supports = (version) => !!tg?.isVersionAtLeast?.(version);
const app = document.getElementById('app');

let profile = null;
let subs = [];
let events = [];
let status = null; // club status — recomputed by recalc() before a screen uses subscriptions
let justChecked = null; // { id, index } — the cell to animate on the next render
let flash = null; // one-time note in the status block after marking an event
let actions = {};

// ---------- helpers ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rub = (n) => `${n.toLocaleString('ru-RU')} ₽`;
const lessonsWord = (n) => `${n} ${plural(n, 'занятие', 'занятия', 'занятий')}`;
const bonusWord = (n) => `${n} ${plural(n, 'бонусное занятие', 'бонусных занятия', 'бонусных занятий')}`;
const eventsWord = (n) => `${n} ${plural(n, 'мероприятие', 'мероприятия', 'мероприятий')}`;
const subsWord = (n) => `${n} ${plural(n, 'абонемент', 'абонемента', 'абонементов')}`;
const daysWord = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function recalc(now) {
  status = clubStatus(subs, events, now);
}

function stateOf(sub, now) {
  const left = sub.size - sub.visits.length;
  const expired = now > sub.until;
  const bonus = bonusOf(sub, status.history);
  const alive = bonusAlive(bonus, now);
  const checkedToday = sub.visits.includes(now) || (sub.bonusVisits || []).some((b) => b.date === now);
  // A card stays on the home screen while its lessons or bonuses can be used, and until the end of the day
  // after a check-in, so the last star can still be shown to the admin. Otherwise it goes to the archive.
  return { left, expired, bonus, bonusAlive: alive, active: (!expired && left > 0) || alive || checkedToday };
}

// ---------- Telegram glue (with browser fallbacks) ----------

function confirmDialog(text) {
  if (supports('6.2')) return new Promise((resolve) => tg.showConfirm(text, resolve));
  return Promise.resolve(window.confirm(text));
}

function alertDialog(text) {
  if (supports('6.2')) tg.showAlert(text);
  else window.alert(text);
}

function haptic() {
  if (supports('6.1')) tg.HapticFeedback.notificationOccurred('success');
}

const nativeBack = supports('6.1');
let backHandler = null;

function setBack(handler) {
  if (nativeBack) {
    if (backHandler) tg.BackButton.offClick(backHandler);
    if (handler) {
      tg.BackButton.onClick(handler);
      tg.BackButton.show();
    } else {
      tg.BackButton.hide();
    }
  }
  backHandler = handler;
}

const backLink = () => (backHandler && !nativeBack ? '<button class="back" data-act="back">← Назад</button>' : '');

function render(html, screenActions = {}) {
  actions = { back: () => backHandler?.(), ...screenActions };
  app.innerHTML = `${html}<div class="ver">v${VERSION}</div>`;
  window.scrollTo(0, 0);
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) actions[el.dataset.act]?.(el.dataset.arg, el);
});

// ---------- screens ----------

function showLoading() {
  app.innerHTML = '<div class="loading"><img class="logo-tile" src="logo.jpg" alt="qlub"></div>';
}

function showError() {
  setBack(null);
  render(
    `<section class="welcome">
      <h1>Не получилось загрузить</h1>
      <p class="hint">Проверь интернет и попробуй ещё раз.</p>
      <button class="btn" data-act="retry">Попробовать ещё раз</button>
    </section>`,
    { retry: () => start() },
  );
}

function showName() {
  const renaming = !!profile?.name;
  setBack(renaming ? showHome : null);
  const value = profile?.name || tg?.initDataUnsafe?.user?.first_name || '';
  render(`${backLink()}
    <section class="welcome">
      <img class="logo-tile" src="logo.jpg" alt="qlub">
      <h1>${renaming ? 'Как к тебе обращаться?' : 'Привет! Как к тебе обращаться?'}</h1>
      <form id="name-form">
        <input class="input" id="name" maxlength="40" autocomplete="given-name" placeholder="Имя или ник" value="${esc(value)}">
        <button class="btn" type="submit">${renaming ? 'Сохранить' : 'Дальше'}</button>
      </form>
    </section>`);

  const form = document.getElementById('name-form');
  const input = document.getElementById('name');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    const btn = form.querySelector('button');
    btn.disabled = true;
    const next = { ...profile, name };
    try {
      await store.saveProfile(next);
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      alertDialog('Не получилось сохранить. Попробуй ещё раз.');
      return;
    }
    profile = next;
    showHome();
  });
}

function showHome() {
  setBack(null);
  const now = today();
  recalc(now);
  const active = subs.filter((s) => stateOf(s, now).active);
  const archived = subs.length - active.length;

  const hello = `<header class="hello">
      <h1>Привет, ${esc(profile.name)}</h1>
      <button class="link" data-act="rename">изменить имя</button>
    </header>`;
  const body = active.length
    ? `<div class="stack">${active.map((s) => cardBlock(s, now)).join('')}</div>
       <button class="btn btn--ghost" data-act="buy">Купить ещё абонемент</button>`
    : `<p class="lead">У тебя пока нет абонемента. Выбери направление:</p>${directionList()}`;
  const archiveNote =
    [archived && subsWord(archived), events.length && eventsWord(events.length)].filter(Boolean).join(' · ') ||
    'пока пусто';
  const menu = `<div class="list menu">
      <button class="tile" data-act="event">
        <span class="tile__main"><span class="tile__title">Я на мероприятии</span><span class="tile__sub">без абонемента, идёт в статус</span></span>
        <span class="chev">›</span>
      </button>
      <button class="tile" data-act="archive">
        <span class="tile__main"><span class="tile__title">Архив</span><span class="tile__sub">${archiveNote}</span></span>
        <span class="chev">›</span>
      </button>
    </div>`;

  render(hello + statusBlock(now) + body + menu, {
    rename: () => showName(),
    buy: () => showDirections(),
    dir: (id) => showPlans(id, showHome),
    renew: (id) => showPlans(subs.find((s) => s.id === id).direction, showHome),
    checkin: (id, btn) => checkIn(id, btn),
    event: () => showEvent(),
    archive: () => showArchive(),
  });

  app.querySelector('.cell--new')?.scrollIntoView({ block: 'center' });
  justChecked = null;
  flash = null;
}

function statusBlock(now) {
  const st = status;
  const n = st.next;
  let next = 'Это высший статус клуба';
  if (n && st.level.id === 'guest') {
    next = `До <b>Red</b>: ещё ${lessonsWord(n.lessonsLeft)} или ${eventsWord(n.eventsLeft)}, либо взнос 1&nbsp;000&nbsp;₽`;
  } else if (n) {
    const counts =
      n.subsLeft && n.eventsLeft ? `ещё ${subsWord(n.subsLeft)} или ${eventsWord(n.eventsLeft)} за последний год` : '';
    const wait = n.yearFrom > now ? `год в ${st.level.name} исполнится ${full(n.yearFrom)}` : '';
    next = `До <b>${n.name}</b>: ${[counts, wait].filter(Boolean).join('; ')}`;
  }

  const perSub = BONUS_BY_LEVEL[st.level.id];
  const available = availableBonuses(subs, st.history, now);
  let bonusLine = '';
  if (available.count) {
    bonusLine = `<p class="status__bonus"><span class="gift-chip">🎁 ${bonusWord(available.count)}</span> до ${short(available.until)}</p>`;
  } else if (perSub) {
    bonusLine = `<p class="status__bonus hint">🎁 ${st.level.name}: +${bonusWord(perSub)} к каждому новому абонементу</p>`;
  }

  return `<section class="status${flash ? ' status--flash' : ''}">
      <div class="status__head">
        <span class="pill pill--${st.level.id}">${st.level.name}</span>
        ${st.since ? `<span class="hint">с ${full(st.since)}</span>` : ''}
      </div>
      <div class="status__counts">Всего: ${lessonsWord(st.lessons)} · ${eventsWord(st.events)}</div>
      ${n ? `<div class="bar"><div class="bar__fill" style="width: ${Math.round(n.progress * 100)}%"></div></div>` : ''}
      <p class="status__next">${next}</p>
      ${bonusLine}
      ${flash ? `<p class="status__flash">✓ ${esc(flash)}</p>` : ''}
    </section>`;
}

function cardBlock(sub, now) {
  const { left, expired } = stateOf(sub, now);
  const note = justChecked?.id === sub.id ? '<p class="hint center">Отмечено! Покажи карточку админу</p>' : '';
  let action;
  if (!expired && left > 0) {
    action = `<button class="btn" data-act="checkin" data-arg="${sub.id}">Я на занятии</button>`;
  } else if (bonusSource(subs, status.history, now)) {
    action = `<button class="btn btn--bonus" data-act="checkin" data-arg="${sub.id}">Я на занятии · за бонус 🎁</button>
      <button class="link link--center" data-act="renew" data-arg="${sub.id}">Купить новый абонемент</button>`;
  } else {
    action = `<button class="btn" data-act="renew" data-arg="${sub.id}">Купить новый абонемент</button>`;
  }
  return `<div>${card(sub, now)}${note}${action}</div>`;
}

function card(sub, now) {
  const { left, expired, active, bonus, bonusAlive: alive } = stateOf(sub, now);
  const fresh = (index) => (justChecked?.id === sub.id && justChecked.index === index ? ' cell--new' : '');
  const off = expired ? ' cell--off' : '';

  const mainCells = Array.from({ length: sub.size }, (_, i) => {
    const visit = sub.visits[i];
    if (!visit) return `<div class="cell${off}"><span class="cell__num">${i + 1}</span></div>`;
    return `<div class="cell cell--done${off}${fresh(i)}">
        <span class="cell__star">★</span><span class="cell__date">${short(visit)}</span>
      </div>`;
  });

  // Bonus cells go after the main ones; a bonus spent on another direction is signed with its name.
  const bonusVisits = sub.bonusVisits || [];
  const bonusCells = Array.from({ length: Math.max(bonus.total, bonusVisits.length) }, (_, i) => {
    const visit = bonusVisits[i];
    if (!visit) {
      return `<div class="cell cell--bonus${now > bonus.until ? ' cell--off' : ''}">
          <span class="cell__gift">🎁</span><span class="cell__num">бонус</span>
        </div>`;
    }
    const label = visit.direction !== sub.direction ? `<span class="cell__label">${esc(visit.title)}</span>` : '';
    return `<div class="cell cell--bonus cell--bonus-done${fresh(sub.size + i)}">
        <span class="cell__gift">🎁</span><span class="cell__date">${short(visit.date)}</span>${label}
      </div>`;
  });

  let mainStatus = left > 0 ? `осталось ${left} из ${sub.size}` : 'все занятия использованы';
  if (expired && left > 0) mainStatus = `срок закончился ${short(sub.until)}, сгорело ${lessonsWord(left)}`;
  let bonusStatus = '';
  if (alive) bonusStatus = `🎁 ${bonusWord(bonus.left)} до ${short(bonus.until)}`;
  else if (bonus.left > 0) bonusStatus = `🎁 ${bonus.left > 1 ? 'бонусы сгорели' : 'бонус сгорел'} ${short(bonus.until)}`;
  const period = active && !expired ? `до ${short(sub.until)}` : `${short(sub.bought)} – ${full(sub.until)}`;

  return `<article class="card${active ? '' : ' card--past'}">
      <div class="card__head">
        <div>
          <div class="card__title">${esc(sub.title)}</div>
          <div class="card__meta">${lessonsWord(sub.size)} · ${period}</div>
        </div>
        <img class="card__logo" src="logo.jpg" alt="qlub">
      </div>
      ${active && sub.payment === 'pending' ? '<div class="badge">оплата проверяется</div>' : ''}
      <div class="cells">${[...mainCells, ...bonusCells].join('')}</div>
      <div class="card__foot">${mainStatus}</div>
      ${bonusStatus ? `<div class="card__bonus">${bonusStatus}</div>` : ''}
    </article>`;
}

function showArchive() {
  setBack(showHome);
  const now = today();
  recalc(now);
  const past = subs.filter((s) => !stateOf(s, now).active);
  const subsPart = past.length
    ? `<h2 class="section">Абонементы · ${past.length}</h2>
       <div class="stack">${past.map((s) => card(s, now)).join('')}</div>`
    : '';
  const eventsPart = events.length
    ? `<h2 class="section">Мероприятия · ${events.length}</h2>
       <div class="list">${events
         .map((e) => `<div class="row"><span class="row__title">${esc(e.title)}</span><span class="hint">${full(e.date)}</span></div>`)
         .join('')}</div>`
    : '';
  const empty =
    past.length || events.length
      ? ''
      : '<p class="lead">Пока пусто. Сюда попадут закончившиеся абонементы и мероприятия, на которых ты отметишься.</p>';
  render(`${backLink()}<h1>Архив</h1>${empty}${subsPart}${eventsPart}`);
}

function showEvent() {
  setBack(showHome);
  render(`${backLink()}
    <h1>Я на мероприятии</h1>
    <p class="lead">Абонемент не нужен — мероприятия идут в счёт статуса.</p>
    <form id="event-form">
      <input class="input" id="event-title" maxlength="60" placeholder="Название, например «Кино»">
      <button class="btn" type="submit">Отметиться</button>
    </form>`);

  const form = document.getElementById('event-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const title = document.getElementById('event-title').value.trim() || 'Мероприятие';
    const now = today();
    btn.disabled = true;
    const question = events.some((ev) => ev.date === now)
      ? `Сегодня уже есть отметка на мероприятии. Отметить ещё «${title}»?`
      : `Отметиться на мероприятии «${title}» сегодня, ${short(now)}?`;
    if (!(await confirmDialog(question))) {
      btn.disabled = false;
      return;
    }
    btn.textContent = 'Отмечаем…';
    const event = { id: newId(), date: now, title };
    try {
      await store.saveEvent(event);
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      btn.textContent = 'Отметиться';
      alertDialog('Не получилось отметиться. Попробуй ещё раз.');
      return;
    }
    events = [event, ...events];
    flash = `Мероприятие «${title}» отмечено`;
    haptic();
    showHome();
  });
}

function directionList() {
  const groups = [...new Set(DIRECTIONS.map((d) => d.group))];
  return groups
    .map(
      (group) => `<h2 class="section">${group}</h2>
      <div class="list">${DIRECTIONS.filter((d) => d.group === group)
        .map(
          (d) => `<button class="tile" data-act="dir" data-arg="${d.id}">
            <span class="tile__main"><span class="tile__title">${d.name}</span><span class="tile__sub">${d.note}</span></span>
            <span class="tile__side">от ${rub(Math.min(...d.plans.map((p) => p.price)))}</span>
          </button>`,
        )
        .join('')}</div>`,
    )
    .join('');
}

function showDirections() {
  setBack(showHome);
  render(`${backLink()}<h1>Какой абонемент?</h1>${directionList()}`, {
    dir: (id) => showPlans(id, showDirections),
  });
}

function showPlans(dirId, back) {
  const dir = DIRECTIONS.find((d) => d.id === dirId);
  setBack(back);
  render(
    `${backLink()}<h1>${dir.name}</h1><p class="lead">${dir.note}</p>
    <div class="list">${dir.plans
      .map(
        (p) => `<button class="tile" data-act="plan" data-arg="${p.size}">
          <span class="tile__main">
            <span class="tile__title">${lessonsWord(p.size)}</span>
            <span class="tile__sub">${daysWord(DAYS_BY_SIZE[p.size])} · ${rub(Math.round(p.price / p.size))} за занятие</span>
          </span>
          <span class="tile__side">${rub(p.price)}</span>
        </button>`,
      )
      .join('')}</div>`,
    {
      plan: (size) => {
        const plan = dir.plans.find((p) => p.size === Number(size));
        showPayment(dir, plan, () => showPlans(dirId, back));
      },
    },
  );
}

function showPayment(dir, plan, back) {
  setBack(back);
  const now = today();
  recalc(now);
  const until = addDays(now, DAYS_BY_SIZE[plan.size]);
  const perSub = BONUS_BY_LEVEL[status.level.id];
  const bonusNote = perSub
    ? `<div class="summary__bonus"><span class="gift-chip">🎁 +${bonusWord(perSub)}</span> — у тебя ${status.level.name}</div>`
    : '';
  const how = PAY_PHONE
    ? `<p>Переведи <b>${rub(plan.price)}</b> по номеру:</p>
       <div class="copy"><span class="copy__value">${esc(PAY_PHONE)}</span><button class="link" data-act="copy">Скопировать</button></div>
       ${PAY_RECIPIENT ? `<p class="hint">${esc(PAY_RECIPIENT)}</p>` : ''}`
    : '<p>Оплата — переводом. Номер для перевода подскажет админ клуба.</p>';

  render(
    `${backLink()}
    <h1>${dir.name} · ${lessonsWord(plan.size)}</h1>
    <div class="summary">
      <div class="summary__sum">${rub(plan.price)}</div>
      <div class="hint">${daysWord(DAYS_BY_SIZE[plan.size])}, до ${short(until)}</div>
      ${bonusNote}
    </div>
    ${how}
    <p class="hint">После перевода нажми «Оплатил(а)» — абонемент сразу появится, а админ проверит оплату.</p>
    <button class="btn" data-act="paid">Оплатил(а)</button>`,
    {
      paid: (_, btn) => buy(dir, plan, btn),
      copy: (_, el) => copyText(PAY_PHONE, el),
    },
  );
}

// ---------- actions ----------

async function buy(dir, plan, btn) {
  btn.disabled = true;
  if (!(await confirmDialog(`Купить ${dir.name} · ${lessonsWord(plan.size)} за ${rub(plan.price)}?`))) {
    btn.disabled = false;
    return;
  }
  btn.textContent = 'Сохраняем…';
  const now = today();
  const sub = {
    id: newId(),
    direction: dir.id,
    title: dir.name,
    size: plan.size,
    price: plan.price,
    bought: now,
    until: addDays(now, DAYS_BY_SIZE[plan.size]),
    payment: 'pending',
    visits: [],
    bonusVisits: [],
  };
  try {
    await store.saveSubscription(sub);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'Оплатил(а)';
    alertDialog('Не получилось сохранить. Попробуй ещё раз.');
    return;
  }
  subs = [sub, ...subs];
  haptic();
  showHome();
}

// A lesson from the card's own subscription while it has lessons; otherwise a bonus lesson,
// taken from the oldest subscription with a bonus still alive.
async function checkIn(id, btn) {
  const now = today();
  recalc(now);
  const sub = subs.find((s) => s.id === id);
  const { left, expired } = stateOf(sub, now);
  const byBonus = expired || left <= 0;
  const target = byBonus ? bonusSource(subs, status.history, now) : sub;
  if (!target) return;

  btn.disabled = true;
  const visitedToday = subs.some(
    (s) =>
      (s.direction === sub.direction && s.visits.includes(now)) ||
      (s.bonusVisits || []).some((b) => b.date === now && b.direction === sub.direction),
  );
  const question = visitedToday
    ? `Сегодня уже есть отметка (${sub.title}). Отметить ещё одно занятие${byBonus ? ' за бонус 🎁' : ''}?`
    : `Отметиться на занятии сегодня, ${short(now)}${byBonus ? ', за бонус 🎁' : ''}?`;
  if (!(await confirmDialog(question))) {
    btn.disabled = false;
    return;
  }
  const label = btn.textContent;
  btn.textContent = 'Отмечаем…';

  const updated = byBonus
    ? {
        ...target,
        bonusVisits: [...(target.bonusVisits || []), { date: now, direction: sub.direction, title: sub.title }],
      }
    : { ...sub, visits: [...sub.visits, now].sort() };
  try {
    await store.saveSubscription(updated);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = label;
    alertDialog('Не получилось отметиться. Попробуй ещё раз.');
    return;
  }
  subs = subs.map((s) => (s.id === updated.id ? updated : s));
  justChecked = {
    id: updated.id,
    index: byBonus ? updated.size + updated.bonusVisits.length - 1 : updated.visits.lastIndexOf(now),
  };
  haptic();
  showHome();
}

async function copyText(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    el.textContent = 'Скопировано';
  } catch {
    alertDialog(text);
  }
}

// ---------- start ----------

async function start() {
  tg?.ready();
  tg?.expand();
  showLoading();
  try {
    [profile, subs, events] = await Promise.all([store.loadProfile(), store.loadSubscriptions(), store.loadEvents()]);
  } catch (err) {
    console.error(err);
    showError();
    return;
  }
  if (profile?.name) showHome();
  else showName();
}

start();
