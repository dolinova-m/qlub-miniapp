import { DIRECTIONS, DAYS_BY_SIZE, PAY_PHONE, PAY_RECIPIENT } from './catalog.js?v=4';
import { today, addDays, short, full } from './dates.js?v=4';
import { clubStatus, isSubscription } from './status.js?v=4';
import { BONUS_BY_LEVEL, bonusOf, bonusAlive, bonusSource, availableBonuses } from './bonuses.js?v=4';
import * as store from './store.js?v=4';

const VERSION = 4;
const tg = window.Telegram?.WebApp;
const supports = (version) => !!tg?.isVersionAtLeast?.(version);
const app = document.getElementById('app');

let profile = null;
let subs = []; // purchases: subscriptions, single and trial lessons (`kind`)
let events = [];
let status = null; // club status — recomputed by recalc() before a screen uses purchases
let justChecked = null; // { id, index } — the cell to animate on the next render
let flash = null; // one-time note on the home screen after an event or an invite
let actions = {};

// ---------- helpers ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rub = (n) => `${n.toLocaleString('ru-RU')} ₽`;
const lessonsWord = (n) => `${n} ${plural(n, 'занятие', 'занятия', 'занятий')}`;
const bonusWord = (n) => `${n} ${plural(n, 'бонусное занятие', 'бонусных занятия', 'бонусных занятий')}`;
const eventsWord = (n) => `${n} ${plural(n, 'мероприятие', 'мероприятия', 'мероприятий')}`;
const subsWord = (n) => `${n} ${plural(n, 'абонемент', 'абонемента', 'абонементов')}`;
const singlesWord = (n) => `${n} ${plural(n, 'разовое', 'разовых', 'разовых')}`;
const daysWord = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const friendLabel = (friend) => (friend.nick ? `@${friend.nick}` : friend.name || friend.phone);

const KIND_NAMES = { single: 'разовое занятие', trial: 'пробное занятие' };
const METHODS = {
  transfer: { name: 'переводом', badge: 'оплата проверяется' },
  cash: { name: 'наличными', badge: 'оплата наличными — отдай админу' },
};

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

// One personal and one pair subscription per direction at a time: a new one only when the current has no lessons
// left or has expired. Single and trial lessons are not limited.
function subscriptionOptions(dir, now) {
  const running = (pair) =>
    subs.some(
      (s) =>
        isSubscription(s) && s.direction === dir.id && !!s.pair === pair && now <= s.until && s.visits.length < s.size,
    );
  const single = !running(false);
  const pair = dir.plans.some((p) => p.pairPrice) && !running(true);
  const prices = [
    ...(single ? dir.plans.map((p) => p.price) : []),
    ...(pair ? dir.plans.filter((p) => p.pairPrice).map((p) => p.pairPrice) : []),
  ];
  return { single, pair, minPrice: prices.length ? Math.min(...prices) : 0 };
}

// A trial lesson is for those who have not been to this direction yet (open question: or to the club at all).
const trialAllowed = (dir) =>
  !!dir.trial &&
  !subs.some(
    (s) =>
      (s.direction === dir.id && s.visits.length) ||
      (s.bonusVisits || []).some((b) => b.direction === dir.id && !b.friend),
  );

// What is being bought: { dir, kind: 'subscription' | 'single' | 'trial', size, pair, price }.
function itemName(item) {
  const what = item.kind === 'subscription' ? lessonsWord(item.size) : KIND_NAMES[item.kind];
  return `${item.dir.name} · ${what}${item.pair ? ' · для пары' : ''}`;
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

const tile = ({ act, arg = '', title, sub = '', side = '', disabled = false }) =>
  `<button class="tile${disabled ? ' tile--off' : ''}"${disabled ? ' disabled' : ` data-act="${act}" data-arg="${arg}"`}>
    <span class="tile__main"><span class="tile__title">${title}</span>${sub ? `<span class="tile__sub">${sub}</span>` : ''}</span>
    ${side ? `<span class="tile__side">${side}</span>` : '<span class="chev">›</span>'}
  </button>`;

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
  const past = subs.filter((s) => !stateOf(s, now).active);

  const hello = `<header class="hello">
      <h1>Привет, ${esc(profile.name)}</h1>
      <button class="link" data-act="rename">изменить имя</button>
    </header>
    ${flash ? `<p class="flash">✓ ${esc(flash)}</p>` : ''}`;
  const body = active.length
    ? `<div class="stack">${active.map((s) => cardBlock(s, now)).join('')}</div>
       <button class="btn btn--ghost" data-act="buy">Купить занятие или абонемент</button>`
    : `<p class="lead">У тебя пока нет абонемента. Выбери направление:</p>${directionList()}`;
  const archivedSubs = past.filter(isSubscription).length;
  const archiveNote =
    [
      archivedSubs && subsWord(archivedSubs),
      past.length - archivedSubs && singlesWord(past.length - archivedSubs),
      events.length && eventsWord(events.length),
    ]
      .filter(Boolean)
      .join(' · ') || 'пока пусто';
  const menu = `<div class="list menu">
      ${tile({ act: 'stats', title: 'Статус и статистика', sub: `${status.level.name} · ${lessonsWord(status.lessons)} · ${eventsWord(status.events)}` })}
      ${tile({ act: 'event', title: 'Я на мероприятии', sub: 'без абонемента, идёт в статус' })}
      ${tile({ act: 'archive', title: 'Архив', sub: archiveNote })}
    </div>`;

  render(hello + body + menu, {
    rename: () => showName(),
    buy: () => showDirections(),
    dir: (id) => showDirection(id, showHome),
    renew: (id) => showPlans(subs.find((s) => s.id === id).direction, showHome),
    checkin: (id, btn) => checkIn(id, btn),
    invite: () => showInvite(),
    stats: () => showStats(),
    event: () => showEvent(),
    archive: () => showArchive(),
  });

  app.querySelector('.cell--new')?.scrollIntoView({ block: 'center' });
  justChecked = null;
  flash = null;
}

function cardBlock(sub, now) {
  const note = justChecked?.id === sub.id ? '<p class="hint center">Отмечено! Покажи карточку админу</p>' : '';
  if (!isSubscription(sub)) return `<div>${card(sub, now)}${note}</div>`;

  const { left, expired } = stateOf(sub, now);
  const source = bonusSource(subs, status.history, now);
  let action;
  if (!expired && left > 0) {
    action = `<button class="btn" data-act="checkin" data-arg="${sub.id}">Я на занятии</button>`;
  } else if (source) {
    action = `<button class="btn btn--bonus" data-act="checkin" data-arg="${sub.id}">Я на занятии · за бонус 🎁</button>`;
  } else {
    action = `<button class="btn" data-act="renew" data-arg="${sub.id}">Купить новый абонемент</button>`;
  }
  // The invite button sits on the card whose bonus goes next.
  const invite =
    source?.id === sub.id ? '<button class="btn btn--ghost btn--gift" data-act="invite">Пригласить друга 🎁</button>' : '';
  const renew =
    (expired || left <= 0) && source
      ? `<button class="link link--center" data-act="renew" data-arg="${sub.id}">Купить новый абонемент</button>`
      : '';
  return `<div>${card(sub, now)}${note}${action}${invite}${renew}</div>`;
}

function card(sub, now) {
  const { left, expired, active, bonus, bonusAlive: alive } = stateOf(sub, now);
  const once = !isSubscription(sub);
  const fresh = (index) => (justChecked?.id === sub.id && justChecked.index === index ? ' cell--new' : '');
  const off = expired && !once ? ' cell--off' : '';

  const mainCells = Array.from({ length: sub.size }, (_, i) => {
    const visit = sub.visits[i];
    if (!visit) return `<div class="cell${off}"><span class="cell__num">${i + 1}</span></div>`;
    return `<div class="cell cell--done${off}${fresh(i)}">
        <span class="cell__star">★</span><span class="cell__date">${short(visit)}</span>
      </div>`;
  });

  // Bonus cells go after the main ones; signed with the friend's name, or the direction if it is another one.
  const bonusVisits = sub.bonusVisits || [];
  const bonusCells = Array.from({ length: Math.max(bonus.total, bonusVisits.length) }, (_, i) => {
    const visit = bonusVisits[i];
    if (!visit) {
      return `<div class="cell cell--bonus${now > bonus.until ? ' cell--off' : ''}">
          <span class="cell__gift">🎁</span><span class="cell__num">бонус</span>
        </div>`;
    }
    let label = '';
    if (visit.friend) label = friendLabel(visit.friend);
    else if (visit.direction !== sub.direction) label = visit.title;
    return `<div class="cell cell--bonus cell--bonus-done${fresh(sub.size + i)}">
        <span class="cell__gift">🎁</span><span class="cell__date">${short(visit.date)}</span>
        ${label ? `<span class="cell__label">${esc(label)}</span>` : ''}
      </div>`;
  });

  let meta;
  let foot;
  if (once) {
    meta = `${full(sub.bought)} · ${rub(sub.price)}${sub.method ? ` · ${METHODS[sub.method].name}` : ''}`;
    foot = KIND_NAMES[sub.kind];
  } else {
    meta = `${lessonsWord(sub.size)} · ${active && !expired ? `до ${short(sub.until)}` : `${short(sub.bought)} – ${full(sub.until)}`}`;
    foot = left > 0 ? `осталось ${left} из ${sub.size}` : 'все занятия использованы';
    if (expired && left > 0) foot = `срок закончился ${short(sub.until)}, сгорело ${lessonsWord(left)}`;
  }
  if (sub.pair?.partner) meta += ` · ты и ${esc(sub.pair.partner)}`;

  let bonusStatus = '';
  if (alive) bonusStatus = `🎁 ${bonusWord(bonus.left)} до ${short(bonus.until)}`;
  else if (bonus.left > 0) bonusStatus = `🎁 ${bonus.left > 1 ? 'бонусы сгорели' : 'бонус сгорел'} ${short(bonus.until)}`;

  const tags = [once ? (sub.kind === 'trial' ? 'пробное' : 'разовое') : '', sub.pair ? 'пара' : '']
    .filter(Boolean)
    .map((t) => `<span class="tag">${t}</span>`)
    .join('');
  const badge = active && sub.payment === 'pending' ? `<div class="badge">${METHODS[sub.method || 'transfer'].badge}</div>` : '';

  return `<article class="card${active ? '' : ' card--past'}">
      <div class="card__head">
        <div>
          <div class="card__title">${esc(sub.title)}${tags}</div>
          <div class="card__meta">${meta}</div>
        </div>
        <img class="card__logo" src="logo.jpg" alt="qlub">
      </div>
      ${badge}
      <div class="cells">${[...mainCells, ...bonusCells].join('')}</div>
      <div class="card__foot">${foot}</div>
      ${bonusStatus ? `<div class="card__bonus">${bonusStatus}</div>` : ''}
    </article>`;
}

function showStats() {
  setBack(showHome);
  const now = today();
  recalc(now);
  const st = status;
  const n = st.next;
  let next = 'Это высший статус клуба';
  if (n && st.level.id === 'guest') {
    next = `До <b>Red</b>: ещё ${lessonsWord(n.lessonsLeft)} или ${eventsWord(n.eventsLeft)}, либо взнос 1&nbsp;000&nbsp;₽`;
  } else if (n) {
    const counts =
      n.subsLeft && n.singlesLeft && n.eventsLeft
        ? `ещё ${subsWord(n.subsLeft)}, ${singlesWord(n.singlesLeft)} или ${eventsWord(n.eventsLeft)} за последний год`
        : '';
    const wait = n.yearFrom > now ? `год в ${st.level.name} исполнится ${full(n.yearFrom)}` : '';
    next = `До <b>${n.name}</b>: ${[counts, wait].filter(Boolean).join('; ')}`;
  }

  const perSub = BONUS_BY_LEVEL[st.level.id];
  const available = availableBonuses(subs, st.history, now);
  const spent = subs.flatMap((s) => s.bonusVisits || []);
  const gifted = spent.filter((b) => b.friend).length;
  const bonusNote = perSub
    ? `${st.level.name}: +${bonusWord(perSub)} к каждому новому абонементу`
    : 'Бонусные занятия начисляются со статуса Red';
  const row = (title, value) => `<div class="row"><span class="row__title">${title}</span><b>${value}</b></div>`;
  const count = (kind) => subs.filter((s) => s.kind === kind).length;

  render(`${backLink()}
    <h1>Статус и статистика</h1>
    <section class="status">
      <div class="status__head">
        <span class="pill pill--${st.level.id}">${st.level.name}</span>
        ${st.since ? `<span class="hint">с ${full(st.since)}</span>` : ''}
      </div>
      <div class="status__counts">Всего: ${lessonsWord(st.lessons)} · ${eventsWord(st.events)}</div>
      ${n ? `<div class="bar"><div class="bar__fill" style="width: ${Math.round(n.progress * 100)}%"></div></div>` : ''}
      <p class="status__next">${next}</p>
    </section>
    <h2 class="section">Бонусы</h2>
    <p class="hint">🎁 ${bonusNote}. Действуют 90 дней с покупки абонемента.</p>
    <div class="list">
      ${row('Доступно', available.count ? `${available.count} · до ${short(available.until)}` : '0')}
      ${row('Потрачено на себя', spent.length - gifted)}
      ${row('Подарено друзьям', gifted)}
    </div>
    <h2 class="section">Всё время</h2>
    <div class="list">
      ${row('Абонементов куплено', subs.filter(isSubscription).length)}
      ${row('Разовых занятий', count('single'))}
      ${row('Пробных занятий', count('trial'))}
      ${row('Занятий', st.lessons)}
      ${row('Мероприятий', st.events)}
    </div>`);
}

function showArchive() {
  setBack(showHome);
  const now = today();
  recalc(now);
  const past = subs.filter((s) => !stateOf(s, now).active);
  const subsPart = past.length
    ? `<h2 class="section">Абонементы и занятия · ${past.length}</h2>
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
      : '<p class="lead">Пока пусто. Сюда попадут закончившиеся абонементы, прошедшие занятия и мероприятия.</p>';
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

function showInvite() {
  const now = today();
  recalc(now);
  const source = bonusSource(subs, status.history, now);
  if (!source) {
    showHome();
    return;
  }
  setBack(showHome);
  const options = DIRECTIONS.map(
    (d) => `<option value="${d.id}"${d.id === source.direction ? ' selected' : ''}>${d.name}</option>`,
  ).join('');
  render(`${backLink()}
    <h1>Пригласить друга 🎁</h1>
    <p class="lead">Подари бонусное занятие тому, кто ещё не был в клубе. Спишется один бонус.</p>
    <form id="invite-form" novalidate>
      <label class="field">
        <span class="field__label">Ник в Telegram</span>
        <input class="input input--left" id="friend-nick" maxlength="40" placeholder="@lena" autocapitalize="off" autocomplete="off">
      </label>
      <p class="field__or">если ника нет</p>
      <label class="field">
        <span class="field__label">Телефон</span>
        <input class="input input--left" id="friend-phone" maxlength="20" inputmode="tel" placeholder="+7 900 000-00-00" autocomplete="off">
      </label>
      <label class="field">
        <span class="field__label">Имя или ник</span>
        <input class="input input--left" id="friend-name" maxlength="40" placeholder="Лена" autocomplete="off">
      </label>
      <label class="field">
        <span class="field__label">Куда приглашаю</span>
        <select class="input input--left" id="friend-dir">${options}</select>
      </label>
      <p class="error" id="invite-error" hidden></p>
      <button class="btn btn--bonus" type="submit">Пригласить за бонус 🎁</button>
    </form>`);

  const form = document.getElementById('invite-form');
  const error = document.getElementById('invite-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = (id) => document.getElementById(id).value.trim();
    const nick = value('friend-nick').replace(/^@+/, '');
    const phone = value('friend-phone');
    const name = value('friend-name');
    if (!nick && !(phone && name)) {
      error.textContent = nick || phone || name ? 'Без ника нужны и телефон, и имя' : 'Укажи ник в Telegram — или телефон и имя';
      error.hidden = false;
      return;
    }
    error.hidden = true;
    const dir = DIRECTIONS.find((d) => d.id === value('friend-dir'));
    const friend = Object.fromEntries(Object.entries({ nick, phone, name }).filter(([, v]) => v));

    const btn = form.querySelector('button');
    btn.disabled = true;
    if (!(await confirmDialog(`Подарить бонусное занятие: ${friendLabel(friend)} · ${dir.name}?`))) {
      btn.disabled = false;
      return;
    }
    btn.textContent = 'Сохраняем…';

    const date = today();
    recalc(date);
    const target = bonusSource(subs, status.history, date);
    if (!target) {
      showHome();
      return;
    }
    const updated = {
      ...target,
      bonusVisits: [...(target.bonusVisits || []), { date, direction: dir.id, title: dir.name, friend }],
    };
    try {
      await store.saveSubscription(updated);
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      btn.textContent = 'Пригласить за бонус 🎁';
      alertDialog('Не получилось сохранить. Попробуй ещё раз.');
      return;
    }
    subs = subs.map((s) => (s.id === updated.id ? updated : s));
    justChecked = { id: updated.id, index: updated.size + updated.bonusVisits.length - 1 };
    flash = `Бонус подарен: ${friendLabel(friend)} · ${dir.name}. Скажи админу, что придёт друг`;
    haptic();
    showHome();
  });
}

// ---------- buying: direction → single / trial / subscription → for one or a pair → (size) → cash or transfer ----------

function directionList() {
  const groups = [...new Set(DIRECTIONS.map((d) => d.group))];
  return groups
    .map(
      (group) => `<h2 class="section">${group}</h2>
      <div class="list">${DIRECTIONS.filter((d) => d.group === group)
        .map((d) => tile({ act: 'dir', arg: d.id, title: d.name, sub: d.note }))
        .join('')}</div>`,
    )
    .join('');
}

function showDirections() {
  setBack(showHome);
  render(`${backLink()}<h1>Что купить?</h1>${directionList()}`, {
    dir: (id) => showDirection(id, showDirections),
  });
}

function showDirection(dirId, back) {
  const dir = DIRECTIONS.find((d) => d.id === dirId);
  setBack(back);
  const again = () => showDirection(dirId, back);
  const pairNote = (price) => (price.pairPrice ? ` · для пары ${rub(price.pairPrice)}` : '');

  const single = tile({
    act: 'once',
    arg: 'single',
    title: 'Разовое занятие',
    sub: `одно занятие${pairNote(dir.single)}`,
    side: rub(dir.single.price),
  });

  let trial = '';
  if (dir.trial) {
    trial = trialAllowed(dir)
      ? tile({
          act: 'once',
          arg: 'trial',
          title: 'Пробное занятие',
          sub: `если ещё не был(а) на ${dir.name}${pairNote(dir.trial)}`,
          side: rub(dir.trial.price),
        })
      : tile({ title: 'Пробное занятие', sub: `только для тех, кто ещё не был на ${dir.name}`, disabled: true });
  }

  const options = subscriptionOptions(dir, today());
  const sizes = dir.plans.map((p) => p.size);
  let subscription;
  if (!options.single && !options.pair) {
    subscription = tile({ title: 'Абонемент', sub: 'уже есть — новый, когда закончится текущий', disabled: true });
  } else {
    subscription = tile({
      act: 'plans',
      title: 'Абонемент',
      sub: options.single
        ? sizes.length > 1
          ? `${sizes.slice(0, -1).join(', ')} или ${lessonsWord(sizes[sizes.length - 1])}`
          : lessonsWord(sizes[0])
        : 'свой действует — можно взять парный',
      side: `от ${rub(options.minPrice)}`,
    });
  }

  render(`${backLink()}<h1>${dir.name}</h1><p class="lead">${dir.note}</p><div class="list">${single}${trial}${subscription}</div>`, {
    once: (kind) => showWho(dir, kind, again),
    plans: () => showPlans(dirId, again),
  });
}

// Single and trial lessons: for one or for a pair, when there is a pair price.
function showWho(dir, kind, back) {
  const price = dir[kind];
  const item = (pair) => ({ dir, kind, size: 1, pair, price: pair ? price.pairPrice : price.price });
  if (!price.pairPrice) {
    showMethod(item(false), back);
    return;
  }
  setBack(back);
  const again = () => showWho(dir, kind, back);
  render(
    `${backLink()}<h1>${dir.name} · ${KIND_NAMES[kind]}</h1>
    <div class="list">
      ${tile({ act: 'who', arg: 'one', title: 'Для одного', side: rub(price.price) })}
      ${tile({ act: 'who', arg: 'pair', title: 'Для пары', sub: 'одна отметка на двоих', side: rub(price.pairPrice) })}
    </div>`,
    { who: (who) => showMethod(item(who === 'pair'), again) },
  );
}

function showPlans(dirId, back) {
  const dir = DIRECTIONS.find((d) => d.id === dirId);
  const options = subscriptionOptions(dir, today());
  setBack(back);
  const again = () => showPlans(dirId, back);

  const tiles = (pair) =>
    dir.plans
      .filter((p) => !pair || p.pairPrice)
      .map((p) => {
        const price = pair ? p.pairPrice : p.price;
        return tile({
          act: pair ? 'pairPlan' : 'plan',
          arg: p.size,
          title: lessonsWord(p.size),
          sub: `${daysWord(DAYS_BY_SIZE[p.size])} · ${rub(Math.round(price / p.size))} за занятие`,
          side: rub(price),
        });
      })
      .join('');

  let body = '';
  if (!options.single && !options.pair) {
    body = `<p class="lead">У тебя уже есть абонемент на ${dir.name}. Новый можно купить, когда в нём кончатся занятия или выйдет срок.</p>`;
  } else {
    if (!options.single) {
      body += `<p class="notice">У тебя уже есть абонемент на ${dir.name} — второй такой же не нужен. Можно взять парный.</p>`;
    }
    if (options.single) body += `${options.pair ? '<h2 class="section">Для одного</h2>' : ''}<div class="list">${tiles(false)}</div>`;
    if (options.pair) body += `<h2 class="section">Для пары · одна карточка на двоих</h2><div class="list">${tiles(true)}</div>`;
  }

  const open = (size, pair) => {
    const plan = dir.plans.find((p) => p.size === Number(size));
    showMethod({ dir, kind: 'subscription', size: plan.size, pair, price: pair ? plan.pairPrice : plan.price }, again);
  };
  render(`${backLink()}<h1>${dir.name} · абонемент</h1><p class="lead">${dir.note}</p>${body}`, {
    plan: (size) => open(size, false),
    pairPlan: (size) => open(size, true),
  });
}

function summary(item, now) {
  let details = 'на сегодняшнее занятие';
  let bonusNote = '';
  if (item.kind === 'subscription') {
    details = `${daysWord(DAYS_BY_SIZE[item.size])}, до ${short(addDays(now, DAYS_BY_SIZE[item.size]))}`;
    const perSub = BONUS_BY_LEVEL[status.level.id];
    if (perSub) {
      bonusNote = `<div class="summary__bonus"><span class="gift-chip">🎁 +${bonusWord(perSub)}</span> — у тебя ${status.level.name}</div>`;
    }
  }
  return `<div class="summary">
      <div class="summary__title">${itemName(item)}</div>
      <div class="summary__sum">${rub(item.price)}</div>
      <div class="hint">${details}</div>
      ${bonusNote}
    </div>`;
}

function showMethod(item, back) {
  setBack(back);
  const now = today();
  recalc(now);
  const again = () => showMethod(item, back);
  render(
    `${backLink()}<h1>Как оплатишь?</h1>
    ${summary(item, now)}
    <div class="list">
      ${tile({ act: 'method', arg: 'transfer', title: 'Переводом', sub: 'по номеру телефона, потом «Оплатил(а)»' })}
      ${tile({ act: 'method', arg: 'cash', title: 'Наличными', sub: 'отдашь админу на занятии' })}
    </div>`,
    { method: (method) => showPay(item, method, again) },
  );
}

function showPay(item, method, back) {
  setBack(back);
  const now = today();
  recalc(now);
  const partner = item.pair
    ? `<label class="field">
        <span class="field__label">Кто второй в паре</span>
        <input class="input input--left" id="partner" maxlength="40" placeholder="Имя или @ник" autocomplete="off">
      </label>`
    : '';
  let how;
  let button;
  if (method === 'cash') {
    how = `<p>Отдай <b>${rub(item.price)}</b> админу на занятии. Покупка появится сразу, админ отметит оплату.</p>`;
    button = 'Оплачу наличными';
  } else {
    how = PAY_PHONE
      ? `<p>Переведи <b>${rub(item.price)}</b> по номеру:</p>
         <div class="copy"><span class="copy__value">${esc(PAY_PHONE)}</span><button class="link" data-act="copy">Скопировать</button></div>
         ${PAY_RECIPIENT ? `<p class="hint">${esc(PAY_RECIPIENT)}</p>` : ''}`
      : '<p>Номер для перевода подскажет админ клуба.</p>';
    how += '<p class="hint">После перевода нажми «Оплатил(а)» — покупка сразу появится, а админ проверит оплату.</p>';
    button = 'Оплатил(а)';
  }

  render(
    `${backLink()}<h1>${method === 'cash' ? 'Наличными' : 'Переводом'}</h1>
    ${summary(item, now)}
    ${partner}
    ${how}
    <button class="btn" data-act="paid">${button}</button>`,
    {
      paid: (_, btn) => buy(item, method, btn),
      copy: (_, el) => copyText(PAY_PHONE, el),
    },
  );
}

// ---------- actions ----------

async function buy(item, method, btn) {
  const now = today();
  // The screen may have stayed open while something else was bought.
  if (item.kind === 'subscription') {
    const options = subscriptionOptions(item.dir, now);
    if (!(item.pair ? options.pair : options.single)) {
      alertDialog(`У тебя уже есть такой абонемент на ${item.dir.name}.`);
      showHome();
      return;
    }
  }
  if (item.kind === 'trial' && !trialAllowed(item.dir)) {
    alertDialog(`Пробное — только для тех, кто ещё не был на ${item.dir.name}.`);
    showHome();
    return;
  }

  const partner = item.pair ? document.getElementById('partner').value.trim() : '';
  const label = btn.textContent;
  btn.disabled = true;
  if (!(await confirmDialog(`Купить ${itemName(item)} за ${rub(item.price)} (${METHODS[method].name})?`))) {
    btn.disabled = false;
    return;
  }
  btn.textContent = 'Сохраняем…';
  const once = item.kind !== 'subscription';
  const record = {
    id: newId(),
    kind: item.kind,
    direction: item.dir.id,
    title: item.dir.name,
    size: item.size,
    price: item.price,
    pair: item.pair ? { partner } : null,
    method,
    bought: now,
    // A single or trial lesson is today's lesson: the star is set right away.
    until: once ? now : addDays(now, DAYS_BY_SIZE[item.size]),
    payment: 'pending',
    visits: once ? [now] : [],
    bonusVisits: [],
  };
  try {
    await store.saveSubscription(record);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = label;
    alertDialog('Не получилось сохранить. Попробуй ещё раз.');
    return;
  }
  subs = [record, ...subs];
  if (once) justChecked = { id: record.id, index: 0 };
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
      (s.bonusVisits || []).some((b) => b.date === now && b.direction === sub.direction && !b.friend),
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
