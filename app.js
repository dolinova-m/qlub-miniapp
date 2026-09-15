import { DIRECTIONS, DAYS_BY_SIZE, PAY_PHONE, PAY_RECIPIENT } from './catalog.js?v=1';
import * as store from './store.js?v=1';

const VERSION = 1;
const tg = window.Telegram?.WebApp;
const supports = (version) => !!tg?.isVersionAtLeast?.(version);
const app = document.getElementById('app');

let profile = null;
let subs = [];
let justChecked = null; // { id, index } — the cell to animate on the next render
let actions = {};

// ---------- helpers ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rub = (n) => `${n.toLocaleString('ru-RU')} ₽`;
const lessons = (n) => `${n} ${plural(n, 'занятие', 'занятия', 'занятий')}`;
const days = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Dates are 'YYYY-MM-DD' strings in Moscow time. Never toISOString() on a local date — it shifts the day.
function today() {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const short = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function stateOf(sub, now) {
  const left = sub.size - sub.visits.length;
  const expired = now > sub.until;
  const checkedToday = sub.visits.includes(now);
  // A used-up card stays on top until the end of the day, so the last star can still be shown to the admin.
  return { left, expired, checkedToday, active: !expired && (left > 0 || checkedToday) };
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
  const active = subs.filter((s) => stateOf(s, now).active);
  const past = subs.filter((s) => !stateOf(s, now).active);

  const hello = `<header class="hello">
      <h1>Привет, ${esc(profile.name)}</h1>
      <button class="link" data-act="rename">изменить имя</button>
    </header>`;
  const body = active.length
    ? `<div class="stack">${active.map((s) => cardBlock(s, now)).join('')}</div>
       <button class="btn btn--ghost" data-act="buy">Купить ещё абонемент</button>`
    : `<p class="lead">У тебя пока нет абонемента. Выбери направление:</p>${directionList()}`;
  const history = past.length
    ? `<h2 class="section">Закончились</h2><div class="stack">${past.map((s) => card(s, now)).join('')}</div>`
    : '';

  render(hello + body + history, {
    rename: () => showName(),
    buy: () => showDirections(),
    dir: (id) => showPlans(id, showHome),
    renew: (id) => showPlans(subs.find((s) => s.id === id).direction, showHome),
    checkin: (id, btn) => checkIn(id, btn),
  });

  app.querySelector('.cell--new')?.scrollIntoView({ block: 'center' });
  justChecked = null;
}

function cardBlock(sub, now) {
  const { left } = stateOf(sub, now);
  const note = justChecked?.id === sub.id ? '<p class="hint center">Отмечено! Покажи карточку админу</p>' : '';
  const action =
    left > 0
      ? `<button class="btn" data-act="checkin" data-arg="${sub.id}">Я на занятии</button>`
      : `<button class="btn" data-act="renew" data-arg="${sub.id}">Купить новый абонемент</button>`;
  return `<div>${card(sub, now)}${note}${action}</div>`;
}

function card(sub, now) {
  const { left, expired, active } = stateOf(sub, now);
  const cells = Array.from({ length: sub.size }, (_, i) => {
    const visit = sub.visits[i];
    if (!visit) return `<div class="cell"><span class="cell__num">${i + 1}</span></div>`;
    const fresh = justChecked?.id === sub.id && justChecked.index === i;
    return `<div class="cell cell--done${fresh ? ' cell--new' : ''}">
        <span class="cell__star">★</span><span class="cell__date">${short(visit)}</span>
      </div>`;
  }).join('');

  let status = left > 0 ? `осталось ${left} из ${sub.size}` : 'все занятия использованы';
  if (expired && left > 0) status = `срок закончился ${short(sub.until)}, сгорело ${lessons(left)}`;

  return `<article class="card${active ? '' : ' card--past'}">
      <div class="card__head">
        <div>
          <div class="card__title">${esc(sub.title)}</div>
          <div class="card__meta">${lessons(sub.size)} · до ${short(sub.until)}</div>
        </div>
        <img class="card__logo" src="logo.jpg" alt="qlub">
      </div>
      ${active && sub.payment === 'pending' ? '<div class="badge">оплата проверяется</div>' : ''}
      <div class="cells">${cells}</div>
      <div class="card__foot">${status}</div>
    </article>`;
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
            <span class="tile__title">${lessons(p.size)}</span>
            <span class="tile__sub">${days(DAYS_BY_SIZE[p.size])} · ${rub(Math.round(p.price / p.size))} за занятие</span>
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
  const until = addDays(today(), DAYS_BY_SIZE[plan.size]);
  const how = PAY_PHONE
    ? `<p>Переведи <b>${rub(plan.price)}</b> по номеру:</p>
       <div class="copy"><span class="copy__value">${esc(PAY_PHONE)}</span><button class="link" data-act="copy">Скопировать</button></div>
       ${PAY_RECIPIENT ? `<p class="hint">${esc(PAY_RECIPIENT)}</p>` : ''}`
    : '<p>Оплата — переводом. Номер для перевода подскажет админ клуба.</p>';

  render(
    `${backLink()}
    <h1>${dir.name} · ${lessons(plan.size)}</h1>
    <div class="summary">
      <div class="summary__sum">${rub(plan.price)}</div>
      <div class="hint">${days(DAYS_BY_SIZE[plan.size])}, до ${short(until)}</div>
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
  if (!(await confirmDialog(`Купить ${dir.name} · ${lessons(plan.size)} за ${rub(plan.price)}?`))) {
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

async function checkIn(id, btn) {
  const sub = subs.find((s) => s.id === id);
  const now = today();
  const { left, expired, checkedToday } = stateOf(sub, now);
  if (left <= 0 || expired) return;

  btn.disabled = true;
  const question = checkedToday
    ? 'Сегодня уже есть отметка. Отметить ещё одно занятие?'
    : `Отметиться на занятии сегодня, ${short(now)}?`;
  if (!(await confirmDialog(question))) {
    btn.disabled = false;
    return;
  }
  btn.textContent = 'Отмечаем…';

  const updated = { ...sub, visits: [...sub.visits, now].sort() };
  try {
    await store.saveSubscription(updated);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'Я на занятии';
    alertDialog('Не получилось отметиться. Попробуй ещё раз.');
    return;
  }
  subs = subs.map((s) => (s.id === id ? updated : s));
  justChecked = { id, index: updated.visits.lastIndexOf(now) };
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
    [profile, subs] = await Promise.all([store.loadProfile(), store.loadSubscriptions()]);
  } catch (err) {
    console.error(err);
    showError();
    return;
  }
  if (profile?.name) showHome();
  else showName();
}

start();
