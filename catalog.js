// Directions and prices. `price` — for one person, `pairPrice` — for a couple (one card for two).
// `single` — one lesson, `trial` — first lesson on the direction, `plans` — subscriptions.
// Source: «Цены Москва.pdf» (dances) and user-spec (online languages: single 550 ₽, 4 lessons — 2 000 ₽, 30 days;
// no pair or trial price).

export const DIRECTIONS = [
  {
    id: 'tango',
    group: 'Танцы',
    name: 'Танго',
    note: 'занятие 1,5 часа',
    single: { price: 850, pairPrice: 1500 },
    trial: { price: 400, pairPrice: 700 },
    plans: [
      { size: 4, price: 3300, pairPrice: 6100 },
      { size: 8, price: 6400, pairPrice: 12100 },
      { size: 12, price: 9000, pairPrice: 16000 },
      { size: 16, price: 11600, pairPrice: 21000 },
    ],
  },
  {
    id: 'latina',
    group: 'Танцы',
    name: 'Латина',
    note: 'бачата, сальса, кизомба · 1 час',
    single: { price: 850, pairPrice: 1500 },
    trial: { price: 400, pairPrice: 700 },
    plans: [
      { size: 4, price: 3300, pairPrice: 6100 },
      { size: 8, price: 5400, pairPrice: 10200 },
      { size: 12, price: 7500, pairPrice: 13350 },
      { size: 16, price: 9200, pairPrice: 16650 },
    ],
  },
  {
    id: 'tribal',
    group: 'Танцы',
    name: 'Трайбл фьюжн',
    note: 'занятие 1,5 часа',
    single: { price: 850, pairPrice: 1500 },
    trial: { price: 400, pairPrice: 700 },
    plans: [
      { size: 4, price: 3300, pairPrice: 6100 },
      { size: 8, price: 6400, pairPrice: 12100 },
      { size: 12, price: 9000, pairPrice: 16000 },
      { size: 16, price: 11600, pairPrice: 21000 },
    ],
  },
  {
    id: 'wcs',
    group: 'Танцы',
    name: 'Вест кост свинг',
    note: 'занятие 1 час',
    single: { price: 850, pairPrice: 1500 },
    trial: { price: 400, pairPrice: 700 },
    plans: [
      { size: 4, price: 3300, pairPrice: 6100 },
      { size: 8, price: 5400, pairPrice: 10200 },
      { size: 12, price: 7500, pairPrice: 13350 },
      { size: 16, price: 9200, pairPrice: 16650 },
    ],
  },
  {
    id: 'english',
    group: 'Языки онлайн',
    name: 'Английский',
    note: 'онлайн',
    single: { price: 550 },
    plans: [{ size: 4, price: 2000 }],
  },
  {
    id: 'spanish',
    group: 'Языки онлайн',
    name: 'Испанский',
    note: 'онлайн',
    single: { price: 550 },
    plans: [{ size: 4, price: 2000 }],
  },
];

// Unlimited — every direction for 30 days («Цены Москва.pdf»). Stored as a subscription on the `unlimited`
// direction with no size: no cells, lessons are not counted down.
export const UNLIMITED = {
  id: 'unlimited',
  name: 'Безлимит',
  note: 'все направления · 30 дней',
  days: 30,
  plans: [{ size: null, price: 14000, pairPrice: 24000 }],
};

// How many days a subscription is valid, by number of lessons.
export const DAYS_BY_SIZE = { 4: 30, 8: 30, 12: 45, 16: 60 };

// Bank transfer details. Empty phone — the payment screen says the admin will give the number.
export const PAY_PHONE = '';
export const PAY_RECIPIENT = '';

// The club bot's username without @ — «Открыть чат с ботом» after a transfer, to send the screenshot.
// Empty — the button closes the mini app, which returns to the chat it was opened from.
export const BOT_USERNAME = '';
