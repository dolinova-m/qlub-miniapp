import { DIRECTIONS, UNLIMITED, DAYS_BY_SIZE, PAY_PHONE, PAY_RECIPIENT, BOT_USERNAME } from './catalog.js?v=5';
import { today, addDays, daysBetween, short, full } from './dates.js?v=5';
import { clubStatus, isSubscription } from './status.js?v=5';
import { BONUS_BY_LEVEL, bonusOf, bonusAlive, bonusSource, availableBonuses } from './bonuses.js?v=5';
import * as store from './store.js?v=5';

const VERSION = 5;
const tg = window.Telegram?.WebApp;
const supports = (version) => !!tg?.isVersionAtLeast?.(version);
const app = document.getElementById('app');

// «Продлить» shows on a card when this many lessons or days are left, or fewer.
const RENEW_LESSONS = 1;
const RENEW_DAYS = 5;
// A status drops a level after this many days without visits or purchases; the home screen warns a month before.
const STATUS_IDLE_DAYS = 90;
const STATUS_WARN_DAYS = 30;

let profile = null;
let subs = []; // purchases: subscriptions, single and trial lessons (`kind`)
let events = [];
let status = null; // club status — recomputed by recalc() before a screen uses purchases
let justChecked = null; // { id, index } — the cell to animate on the next render
let flash = null; // one-time note on the home screen after an event, an invite or a cash purchase
let actions = {};

// ---------- helpers ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rub = (n) => `${n.toLocaleString('ru-RU')} ₽`;
const lessonsWord = (n) => `${n} ${plural(n, 'занятие', 'занятия', 'занятий')}`;
const bonusWord = (n) => `${n} ${plural(n, 'бонусное занятие', 'бонусных занятия', 'бонусных занятий')}`;
const bonusShort = (n) => `${n} ${plural(n, 'бонус', 'бонуса', 'бонусов')}`;
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
// Pair partner: a Telegram nick; records saved before v5 have free text in `partner`.
const partnerLabel = (pair) => (pair?.nick ? `@${pair.nick}` : pair?.partner || '');
const TELEGRAM_NICK = /^[A-Za-z0-9_]{4,32}$/;

const KIND_NAMES = { single: 'разовое занятие', trial: 'пробное занятие' };
const METHODS = {
  transfer: { name: 'переводом', badge: 'оплата проверяется' },
  cash: { name: 'наличными', badge: 'отдай наличные админу' },
};

const findDir = (id) => (id === UNLIMITED.id ? UNLIMITED : DIRECTIONS.find((d) => d.id === id));
const isUnlimited = (sub) => sub.direction === UNLIMITED.id;
const planDays = (dir, size) => dir.days || DAYS_BY_SIZE[size];

function recalc(now) {
  status = clubStatus(subs, events, now);
}

function stateOf(sub, now) {
  const unlimited = isUnlimited(sub);
  const left = unlimited ? Infinity : sub.size - sub.visits.length;
  const expired = now > sub.until;
  const bonus = bonusOf(sub, status.history);
  const alive = bonusAlive(bonus, now);
  const checkedToday = sub.visits.includes(now) || (sub.bonusVisits || []).some((b) => b.date === now);
  // Ending — time to buy the next one: few lessons or days left, or already over.
  const ending = expired || left <= RENEW_LESSONS || daysBetween(now, sub.until) <= RENEW_DAYS;
  // A card stays on the home screen while its lessons or bonuses can be used, and until the end of the day
  // after a check-in, so the last star can still be shown to the admin. Otherwise it goes to the history.
  return {
    unlimited,
    left,
    expired,
    ending,
    bonus,
    bonusAlive: alive,
    active: (!expired && left > 0) || alive || checkedToday,
  };
}

// One running personal and one pair subscription per direction: a new one only when the current one is ending —
// the same moment its card offers «Продлить». Single and trial lessons are not limited.
function subscriptionOptions(dir, now) {
  const running = (pair) =>
    subs.some((s) => isSubscription(s) && s.direction === dir.id && !!s.pair === pair && !stateOf(s, now).ending);
  return { single: !running(false), pair: dir.plans.some((p) => p.pairPrice) && !running(true) };
}

// A newer subscription of the same kind on the same direction was bought — the old card stops offering «Продлить».
const renewedBy = (sub) =>
  subs.some(
    (s) =>
      s.id !== sub.id &&
      isSubscription(s) &&
      s.direction === sub.direction &&
      !!s.pair === !!sub.pair &&
      (s.bought > sub.bought || (s.bought === sub.bought && s.id > sub.id)),
  );

// The same subscription at today's price, or null if the catalog no longer has it.
function renewItem(sub) {
  const dir = findDir(sub.direction);
  const plan = dir?.plans.find((p) => p.size === sub.size);
  const price = plan && (sub.pair ? plan.pairPrice : plan.price);
  return price ? { dir, kind: 'subscription', size: plan.size, pair: !!sub.pair, price } : null;
}

const canRenew = (sub, now) => isSubscription(sub) && stateOf(sub, now).ending && !renewedBy(sub) && !!renewItem(sub);

// A trial lesson is only for newcomers — those who have not been to the club at all.
const trialAllowed = (dir) => !!dir.trial && !subs.length && !events.length;

// What is being bought: { dir, kind: 'subscription' | 'single' | 'trial', size, pair, price }.
function itemName(item) {
  let what = KIND_NAMES[item.kind];
  if (item.kind === 'subscription') what = item.size ? lessonsWord(item.size) : UNLIMITED.note;
  return `${item.dir.name} · ${what}${item.pair ? ' · для пары' : ''}`;
}

// The last visit or purchase — a status is kept while there is one within STATUS_IDLE_DAYS.
function lastActivity() {
  const dates = [
    ...subs.flatMap((s) => [s.bought, ...s.visits, ...(s.bonusVisits || []).filter((b) => !b.friend).map((b) => b.date)]),
    ...events.map((e) => e.date),
  ].sort();
  return dates[dates.length - 1] || null;
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

// The screenshot of a transfer goes to the bot chat; the bot forwards it to the admins.
function openBotChat() {
  if (BOT_USERNAME && supports('6.1')) tg.openTelegramLink(`https://t.me/${BOT_USERNAME}`);
  else if (BOT_USERNAME) window.open(`https://t.me/${BOT_USERNAME}`, '_blank');
  else if (tg?.initData) tg.close();
  else alertDialog('Открой чат с ботом qlub и отправь туда скриншот перевода.');
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

// Home: subscription cards, the club status, links. Buying stays out of the way until it is needed.
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
  const cards = active.length
    ? `<div class="stack">${active.map((s) => cardBlock(s, now)).join('')}</div>`
    : `<article class="card card--empty">
        <div class="card__title">Абонемента сейчас нет</div>
        <button class="btn" data-act="buy">Выбрать абонемент</button>
        <p class="card__hint">или купи у админа на занятии</p>
      </article>`;
  const archivedSubs = past.filter(isSubscription).length;
  const historyNote =
    [
      archivedSubs && subsWord(archivedSubs),
      past.length - archivedSubs && singlesWord(past.length - archivedSubs),
      events.length && eventsWord(events.length),
    ]
      .filter(Boolean)
      .join(' · ') || 'пока пусто';
  const menu = `<div class="list menu">
      ${tile({ act: 'buy', title: 'Цены и абонементы' })}
      ${tile({ act: 'event', title: 'Я на мероприятии', sub: 'без абонемента, идёт в статус' })}
      ${tile({ act: 'archive', title: 'История', sub: historyNote })}
    </div>`;

  render(hello + cards + statusBlock(now) + menu, {
    rename: () => showName(),
    buy: () => showDirections(),
    renew: (id) => renew(id),
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

const PATH_WORDS = { lessons: lessonsWord, events: eventsWord, subs: subsWord, singles: singlesWord };

// Club status on the home screen: the closest path to the next level in large print, the rest in small print.
function statusBlock(now) {
  const st = status;
  const n = st.next;
  const yearly = st.level.id !== 'guest';
  let main = 'Высший статус клуба';
  let rest = '';
  if (n) {
    const word = (p) => PATH_WORDS[p.id](p.left);
    const [closest, ...others] = [...n.paths].sort((a, b) => (b.total - b.left) / b.total - (a.total - a.left) / a.total);
    const wait = yearly && n.yearFrom > now ? `год в ${st.level.name} исполнится ${full(n.yearFrom)}` : '';
    if (closest.left > 0) {
      main = `До <b>${n.name}</b>: ещё ${word(closest)}${yearly ? ' за год' : ''}`;
      rest = [`или ${others.map(word).join(', или ')}${yearly ? '' : ', либо взнос 1&nbsp;000&nbsp;₽'}`, wait]
        .filter(Boolean)
        .join(' · ');
    } else {
      main = `До <b>${n.name}</b>: ${wait}`;
    }
  }

  let warn = '';
  const last = lastActivity();
  if (yearly && last) {
    const until = addDays(last, STATUS_IDLE_DAYS);
    const days = daysBetween(now, until);
    if (days < 0) warn = `3 месяца без посещений — ${st.level.name} может снизиться`;
    else if (days <= STATUS_WARN_DAYS) warn = `Приходи до ${short(until)}, чтобы сохранить ${st.level.name}`;
  }

  return `<h2 class="section">Клубный статус</h2>
    <button class="status status--tap" data-act="stats">
      <span class="status__head">
        <span class="pill pill--${st.level.id}">${st.level.name}</span>
        ${st.since ? `<span class="hint">с ${full(st.since)}</span>` : ''}
        <span class="chev">›</span>
      </span>
      ${n ? `<span class="bar"><span class="bar__fill" style="width: ${Math.round(n.progress * 100)}%"></span></span>` : ''}
      <span class="status__main">${main}</span>
      ${rest ? `<span class="status__rest">${rest}</span>` : ''}
      ${warn ? `<span class="status__warn">${warn}</span>` : ''}
    </button>`;
}

function cardBlock(sub, now) {
  const note = justChecked?.id === sub.id ? '<p class="hint center">Отмечено! Покажи карточку админу</p>' : '';
  if (!isSubscription(sub)) return `<div>${card(sub, now)}${note}</div>`;

  const { left, expired } = stateOf(sub, now);
  const source = bonusSource(subs, status.history, now);
  const buttons = [];
  if (!expired && left > 0) {
    buttons.push(`<button class="btn" data-act="checkin" data-arg="${sub.id}">Я на занятии</button>`);
  } else if (source) {
    buttons.push(`<button class="btn btn--bonus" data-act="checkin" data-arg="${sub.id}">Я на занятии · 🎁</button>`);
  }
  if (canRenew(sub, now)) {
    buttons.push(
      `<button class="btn${buttons.length ? ' btn--ghost' : ''}" data-act="renew" data-arg="${sub.id}">Продлить</button>`,
    );
  }
  // «подарить другу» sits on the card whose bonus goes next.
  return `<div>${card(sub, now, { actions: buttons.join(''), invite: source?.id === sub.id })}${note}</div>`;
}

function card(sub, now, { actions: buttons = '', invite = false } = {}) {
  const { unlimited, left, expired, active, bonus, bonusAlive: alive } = stateOf(sub, now);
  const once = !isSubscription(sub);
  const fresh = (index) => (justChecked?.id === sub.id && justChecked.index === index ? ' cell--new' : '');
  const off = expired && !once ? ' cell--off' : '';

  const mainCells = unlimited
    ? []
    : Array.from({ length: sub.size }, (_, i) => {
        const visit = sub.visits[i];
        if (!visit) return `<div class="cell${off}"><span class="cell__num">${i + 1}</span></div>`;
        return `<div class="cell cell--done${off}${fresh(i)}">
            <span class="cell__star">★</span><span class="cell__date">${short(visit)}</span>
          </div>`;
      });

  // Bonus cells go after the main ones. Who or where a bonus went does not fit a small cell — it goes to a note line.
  const bonusVisits = sub.bonusVisits || [];
  const notes = [];
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
    if (label) notes.push(`${short(visit.date)} — ${esc(label)}`);
    return `<div class="cell cell--bonus cell--bonus-done${fresh(mainCells.length + i)}">
        <span class="cell__gift">🎁</span><span class="cell__date">${short(visit.date)}</span>
      </div>`;
  });

  // At most 6 cells in a row, rows of equal length: 4 + 1 bonus — one row of 5, 16 + 2 — three rows of 6.
  const cells = [...mainCells, ...bonusCells];
  const rows = Math.ceil(cells.length / 6);
  const cols = Math.max(4, rows ? Math.ceil(cells.length / rows) : 0);

  const period = active && !expired ? `до ${short(sub.until)}` : `${short(sub.bought)} – ${full(sub.until)}`;
  let meta;
  let foot;
  if (once) {
    meta = `${full(sub.bought)} · ${rub(sub.price)}${sub.method ? ` · ${METHODS[sub.method].name}` : ''}`;
    foot = KIND_NAMES[sub.kind];
  } else if (unlimited) {
    meta = `все направления · ${period}`;
    foot = sub.visits.length ? `${lessonsWord(sub.visits.length)} за срок` : 'занятий пока не было';
    if (sub.visits.includes(now)) foot += ' · сегодня ★';
  } else {
    meta = `${lessonsWord(sub.size)} · ${period}`;
    foot = left > 0 ? `осталось ${left} из ${sub.size}` : 'все занятия использованы';
    if (expired && left > 0) foot = `срок закончился ${short(sub.until)}, сгорело ${lessonsWord(left)}`;
  }
  const partner = partnerLabel(sub.pair);
  if (partner) meta += ` · ты и ${esc(partner)}`;

  let bonusStatus = '';
  if (alive) bonusStatus = `🎁 ${bonusShort(bonus.left)} до ${short(bonus.until)}`;
  else if (bonus.left > 0) bonusStatus = `🎁 ${bonus.left > 1 ? 'бонусы сгорели' : 'бонус сгорел'} ${short(bonus.until)}`;
  if (invite) bonusStatus += ` · <button class="link link--gift" data-act="invite">подарить другу</button>`;

  const tags = [once ? (sub.kind === 'trial' ? 'пробное' : 'разовое') : '', sub.pair ? 'пара' : '']
    .filter(Boolean)
    .map((t) => `<span class="tag">${t}</span>`)
    .join('');
  const badge =
    active && sub.payment === 'pending' ? `<span class="badge">${METHODS[sub.method || 'transfer'].badge}</span>` : '';

  return `<article class="card${active ? '' : ' card--past'}">
      <div class="card__head">
        <div>
          <div class="card__title">${esc(sub.title)}${tags}</div>
          <div class="card__meta"><span>${meta}</span>${badge}</div>
        </div>
        <img class="card__logo" src="logo.jpg" alt="qlub">
      </div>
      ${cells.length ? `<div class="cells" style="--cols: ${cols}">${cells.join('')}</div>` : ''}
      <div class="card__foot"><span>${foot}</span>${bonusStatus ? `<span class="card__bonus">${bonusStatus}</span>` : ''}</div>
      ${notes.length ? `<div class="card__notes">🎁 ${notes.join(' · ')}</div>` : ''}
      ${buttons ? `<div class="card__actions">${buttons}</div>` : ''}
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
  render(`${backLink()}<h1>История</h1>${empty}${subsPart}${eventsPart}`);
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
    justChecked = { id: updated.id, index: (isUnlimited(updated) ? 0 : updated.size) + updated.bonusVisits.length - 1 };
    flash = `Бонус подарен: ${friendLabel(friend)} · ${dir.name}. Скажи админу, что придёт друг`;
    haptic();
    showHome();
  });
}

// ---------- buying: prices → direction (subscriptions first) → payment → screenshot to the bot ----------

function directionList() {
  const groups = [...new Set(DIRECTIONS.map((d) => d.group))];
  const price = (dir) => `${dir.plans.length > 1 ? 'от ' : ''}${rub(Math.min(...dir.plans.map((p) => p.price)))}`;
  const directions = groups
    .map(
      (group) => `<h2 class="section">${group}</h2>
      <div class="list">${DIRECTIONS.filter((d) => d.group === group)
        .map((d) => tile({ act: 'dir', arg: d.id, title: d.name, sub: d.note, side: price(d) }))
        .join('')}</div>`,
    )
    .join('');
  const unlimited = `<h2 class="section">${UNLIMITED.name}</h2>
    <div class="list">${tile({ act: 'dir', arg: UNLIMITED.id, title: UNLIMITED.name, sub: UNLIMITED.note, side: price(UNLIMITED) })}</div>`;
  return directions + unlimited;
}

function showDirections() {
  setBack(showHome);
  render(`${backLink()}<h1>Цены и абонементы</h1>${directionList()}`, {
    dir: (id) => showDirection(id, showDirections),
  });
}

// A direction: subscriptions right away with the price per lesson; a single (or, for a newcomer, a trial) lesson
// only as a small link below — the goal is to lead to subscriptions.
function showDirection(dirId, back, pair = false) {
  const dir = findDir(dirId);
  const now = today();
  recalc(now);
  setBack(back);
  const again = () => showDirection(dirId, back, pair);
  const unlimited = dir === UNLIMITED;
  const options = subscriptionOptions(dir, now);
  const allowed = pair ? options.pair : options.single;

  const toggle = dir.plans.some((p) => p.pairPrice)
    ? `<div class="segmented">
        <button class="segmented__item${pair ? '' : ' is-on'}" data-act="who" data-arg="one">Один</button>
        <button class="segmented__item${pair ? ' is-on' : ''}" data-act="who" data-arg="pair">Пара</button>
      </div>
      ${pair ? '<p class="hint">Одна карточка на двоих: пришли оба или один — списывается одно занятие</p>' : ''}`
    : '';

  let notice = '';
  if (!allowed) {
    const current = `${pair ? 'парный ' : ''}${unlimited ? 'безлимит' : `абонемент на ${dir.name}`}`;
    const when = unlimited
      ? ` за ${daysWord(RENEW_DAYS)} до конца`
      : `, когда в нём останется одно занятие или ${daysWord(RENEW_DAYS)} до конца`;
    notice = `<p class="notice">У тебя уже есть ${current}. Новый можно купить${when}.</p>`;
  }

  const plans = dir.plans
    .filter((p) => !pair || p.pairPrice)
    .map((p) => {
      const price = pair ? p.pairPrice : p.price;
      const days = planDays(dir, p.size);
      return tile({
        act: 'plan',
        arg: p.size ?? '',
        title: p.size ? lessonsWord(p.size) : daysWord(days),
        sub: p.size
          ? `${daysWord(days)} · ${rub(Math.round(price / p.size))} за занятие${pair ? ' на двоих' : ''}`
          : 'все регулярные занятия, сколько угодно',
        side: rub(price),
        disabled: !allowed,
      });
    })
    .join('');

  const perSub = BONUS_BY_LEVEL[status.level.id];
  const bonus = perSub
    ? `<p class="bonus-note">🎁 С твоим ${status.level.name} +${bonusWord(perSub)} к абонементу</p>`
    : '';

  let extra = '';
  const onceKind = trialAllowed(dir) ? 'trial' : 'single';
  const once = dir[onceKind];
  const oncePrice = once && (pair ? once.pairPrice : once.price);
  if (oncePrice) {
    extra = `<div class="extra">
        <button class="link" data-act="once" data-arg="${onceKind}">${onceKind === 'trial' ? 'Пробное занятие' : 'Разовое занятие'}${pair ? ' для пары' : ''} — ${rub(oncePrice)}</button>
        ${onceKind === 'trial' ? '<p class="hint">Возьмёшь абонемент в тот же день — пробное бесплатно</p>' : ''}
      </div>`;
  }

  render(
    `${backLink()}<h1>${dir.name}</h1><p class="lead">${dir.note}</p>${toggle}${notice}<div class="list">${plans}</div>${bonus}${extra}`,
    {
      who: (who) => showDirection(dirId, back, who === 'pair'),
      plan: (size) => {
        const plan = dir.plans.find((p) => String(p.size ?? '') === size);
        showPay({ dir, kind: 'subscription', size: plan.size, pair, price: pair ? plan.pairPrice : plan.price }, again);
      },
      once: (kind) => showPay({ dir, kind, size: 1, pair, price: pair ? dir[kind].pairPrice : dir[kind].price }, again),
    },
  );
}

// «Продлить»: straight to payment for the same subscription, with a link to pick another one.
function renew(id) {
  const sub = subs.find((s) => s.id === id);
  const item = renewItem(sub);
  if (item) showPay(item, showHome, { partnerNick: sub.pair?.nick || '', change: true });
  else showDirection(sub.direction, showHome, !!sub.pair);
}

function summary(item, now) {
  let details = 'на сегодняшнее занятие';
  let bonusNote = '';
  if (item.kind === 'subscription') {
    const days = planDays(item.dir, item.size);
    details = `${daysWord(days)}, до ${short(addDays(now, days))}`;
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

function showPay(item, back, { partnerNick = '', change = false } = {}) {
  setBack(back);
  const now = today();
  recalc(now);
  const partner = item.pair
    ? `<label class="field">
        <span class="field__label">Ник второго в Telegram — по нему второй увидит карточку у себя</span>
        <input class="input input--left" id="partner" maxlength="33" placeholder="@nick" autocapitalize="off" autocomplete="off" value="${partnerNick ? `@${esc(partnerNick)}` : ''}">
      </label>`
    : '';
  const how = PAY_PHONE
    ? `<p>Переведи <b>${rub(item.price)}</b> по номеру:</p>
       <div class="copy"><span class="copy__value">${esc(PAY_PHONE)}</span><button class="link" data-act="copy">Скопировать</button></div>
       ${PAY_RECIPIENT ? `<p class="hint">${esc(PAY_RECIPIENT)}</p>` : ''}`
    : '<p>Номер для перевода подскажет админ клуба.</p>';

  render(
    `${backLink()}<h1>Оплата</h1>
    ${summary(item, now)}
    ${change ? '<button class="link" data-act="change">выбрать другой абонемент</button>' : ''}
    ${partner}
    <p class="error" id="pay-error" hidden></p>
    ${how}
    <p class="hint">После перевода нажми «Я перевёл(а)» и отправь скриншот в чат с ботом — бот передаст его админу.</p>
    <button class="btn" data-act="paid" data-arg="transfer">Я перевёл(а)</button>
    <button class="link link--center" data-act="paid" data-arg="cash">Наличными — отдам админу</button>`,
    {
      paid: (method, btn) => buy(item, method, btn),
      copy: (_, el) => copyText(PAY_PHONE, el),
      change: () => showDirection(item.dir.id, back, item.pair),
    },
  );
}

function showScreenshot() {
  setBack(showHome);
  render(
    `${backLink()}
    <section class="welcome">
      <div class="big-icon">📸</div>
      <h1>Остался шаг — скриншот</h1>
      <p class="lead">Отправь скриншот перевода в чат с ботом — бот передаст его админу. Покупка уже в карточке.</p>
      <button class="btn" data-act="chat">Открыть чат с ботом</button>
      <button class="link link--center" data-act="home">На главную</button>
    </section>`,
    { chat: () => openBotChat(), home: () => showHome() },
  );
}

// ---------- actions ----------

async function buy(item, method, btn) {
  const now = today();
  recalc(now);
  // The screen may have stayed open while something else was bought.
  if (item.kind === 'subscription') {
    const options = subscriptionOptions(item.dir, now);
    if (!(item.pair ? options.pair : options.single)) {
      alertDialog('У тебя уже есть такой абонемент — новый можно купить, когда он будет заканчиваться.');
      showHome();
      return;
    }
  }
  if (item.kind === 'trial' && !trialAllowed(item.dir)) {
    alertDialog('Пробное — только для тех, кто ещё не был в клубе.');
    showHome();
    return;
  }

  let nick = '';
  if (item.pair) {
    const input = document.getElementById('partner');
    const error = document.getElementById('pay-error');
    nick = input.value.trim().replace(/^@+/, '');
    if (!TELEGRAM_NICK.test(nick)) {
      error.textContent = nick ? 'Ник в Telegram — латиница, цифры и _, от 4 символов' : 'Укажи ник второго в Telegram';
      error.hidden = false;
      input.focus();
      return;
    }
    error.hidden = true;
  }

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
    pair: item.pair ? { nick } : null,
    method,
    bought: now,
    // A single or trial lesson is today's lesson: the star is set right away.
    until: once ? now : addDays(now, planDays(item.dir, item.size)),
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
  if (method === 'transfer') {
    showScreenshot();
  } else {
    flash = `Отдай ${rub(item.price)} админу на занятии`;
    showHome();
  }
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
    index: byBonus
      ? (isUnlimited(updated) ? 0 : updated.size) + updated.bonusVisits.length - 1
      : updated.visits.lastIndexOf(now),
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
