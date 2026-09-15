// Directions and prices.
// Source: «Цены Москва.pdf» (dances) and user-spec (online languages: 4 lessons — 2 000 ₽, 30 days).

export const DIRECTIONS = [
  {
    id: 'tango',
    group: 'Танцы',
    name: 'Танго',
    note: 'занятие 1,5 часа',
    plans: [{ size: 4, price: 3300 }, { size: 8, price: 6400 }, { size: 12, price: 9000 }, { size: 16, price: 11600 }],
  },
  {
    id: 'latina',
    group: 'Танцы',
    name: 'Латина',
    note: 'бачата, сальса, кизомба · 1 час',
    plans: [{ size: 4, price: 3300 }, { size: 8, price: 5400 }, { size: 12, price: 7500 }, { size: 16, price: 9200 }],
  },
  {
    id: 'tribal',
    group: 'Танцы',
    name: 'Трайбл фьюжн',
    note: 'занятие 1,5 часа',
    plans: [{ size: 4, price: 3300 }, { size: 8, price: 6400 }, { size: 12, price: 9000 }, { size: 16, price: 11600 }],
  },
  {
    id: 'wcs',
    group: 'Танцы',
    name: 'Вест кост свинг',
    note: 'занятие 1 час',
    plans: [{ size: 4, price: 3300 }, { size: 8, price: 5400 }, { size: 12, price: 7500 }, { size: 16, price: 9200 }],
  },
  {
    id: 'english',
    group: 'Языки онлайн',
    name: 'Английский',
    note: 'онлайн',
    plans: [{ size: 4, price: 2000 }],
  },
  {
    id: 'spanish',
    group: 'Языки онлайн',
    name: 'Испанский',
    note: 'онлайн',
    plans: [{ size: 4, price: 2000 }],
  },
];

// How many days a subscription is valid, by number of lessons.
export const DAYS_BY_SIZE = { 4: 30, 8: 30, 12: 45, 16: 60 };

// Bank transfer details. Empty phone — the payment screen says the admin will give the number.
export const PAY_PHONE = '';
export const PAY_RECIPIENT = '';
