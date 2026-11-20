'use strict';

/* =====================================================================
   Planner studenta
   ---------------------------------------------------------------------
   Każde zadanie oceniamy na dwóch osiach:
   1. WAŻNOŚĆ  – pole "priorytet" z pliku JSON (niski / sredni / wysoki),
   2. PILNOŚĆ  – liczona automatycznie z liczby dni do terminu.
   Na tej podstawie aplikacja:
   - rozkłada "sesje pracy" na dni przed terminem (wysoki 4, średni 2, niski 1),
   - liczy punkty obciążenia każdego dnia i ostrzega o przeciążeniu (> 5 pkt).
   Format pliku JSON pozostaje nietknięty – nic nie dopisujemy do zadań.
   ===================================================================== */

// ---------- Ustawienia ----------
const KLUCZ_DANE = 'planner.dane';     // zadania (ten sam format co plik JSON)
const KLUCZ_SESJE = 'planner.sesje';   // odhaczone sesje pracy: { idZadania: [daty] }

const PRIORYTETY = ['niski', 'sredni', 'wysoki'];
const NAZWA_PRIORYTETU = { niski: 'Niski', sredni: 'Średni', wysoki: 'Wysoki' };
const WAGA_PRIORYTETU = { niski: 1, sredni: 2, wysoki: 3 };

const SESJE_NA_PRIORYTET = { wysoki: 4, sredni: 2, niski: 1 };
const PUNKTY_ZA_TERMIN = { wysoki: 3, sredni: 2, niski: 1 };
const PUNKTY_ZA_SESJE = 1;
const LIMIT_DNIA = 5;        // powyżej tej liczby punktów dzień jest przeciążony
const HORYZONT_DNI = 14;     // ile dni do przodu planujemy i sprawdzamy

const NAZWA_PILNOSCI = { pilne: 'Pilne', wkrotce: 'Wkrótce', spokojnie: 'Spokojnie' };

// ---------- Stan aplikacji ----------
let dane = { wersja: 1, zadania: [] };
let sesje = {};
let widok = 'terminarz';   // widok startowy: kalendarz
const filtry = { szukaj: '', tag: '', grupuj: 'pilnosc', pokazZrobione: false };
let szczegolyId = null;   // zadanie otwarte w oknie szczegółów
let edytowaneId = null;

// "Dziś" można nadpisać do testów/prezentacji: index.html?dzis=2026-11-20
const DZIS = (() => {
  const z = new URLSearchParams(location.search).get('dzis');
  return z && poprawnaData(z) ? z : naISO(new Date());
})();

/* =====================================================================
   Daty – zawsze jako tekst "RRRR-MM-DD" (taki jak w pliku JSON)
   ===================================================================== */
function naISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function zISO(s) {
  const [r, m, d] = s.split('-').map(Number);
  return new Date(r, m - 1, d);
}
function poprawnaData(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && naISO(zISO(s)) === s;
}
function dodajDni(s, n) {
  const d = zISO(s);
  d.setDate(d.getDate() + n);
  return naISO(d);
}
/** Ile dni od daty a do daty b (b - a). */
function roznicaDni(a, b) {
  const [r1, m1, d1] = a.split('-').map(Number);
  const [r2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(r2, m2 - 1, d2) - Date.UTC(r1, m1 - 1, d1)) / 86400000);
}
function ladnaData(s, zDniem = true) {
  const opcje = zDniem ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' };
  return zISO(s).toLocaleDateString('pl-PL', opcje);
}
function opisTerminu(termin) {
  if (!termin) return 'bez terminu';
  const d = roznicaDni(DZIS, termin);
  if (d === 0) return 'dziś';
  if (d === 1) return 'jutro';
  if (d === -1) return 'wczoraj (po terminie)';
  if (d < 0) return `${-d} dni po terminie`;
  return `za ${d} dni · ${ladnaData(termin)}`;
}

/* =====================================================================
   Wczytywanie i sprawdzanie pliku JSON
   ===================================================================== */

/** Ustawia pola zadania w tej samej kolejności co w oryginalnym pliku.
    Nieznane pola (gdyby były w pliku) zostają zachowane na końcu. */
function uporzadkuj(z) {
  const { id, tytul, opis, termin, priorytet, wykonane, tagi, ...reszta } = z;
  return { id, tytul, opis, termin, priorytet, wykonane, tagi, ...reszta };
}

/** Sprawdza i naprawia dane z pliku. Zwraca { dane, ostrzezenia }. */
function normalizuj(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.zadania)) {
    throw new Error('W pliku brakuje listy "zadania".');
  }
  const ostrzezenia = [];
  const wersja = obj.wersja === undefined ? 1 : obj.wersja;
  if (wersja !== 1) ostrzezenia.push(`Nieznana wersja pliku (${wersja}) – próbuję wczytać mimo to.`);

  let maxId = 0;
  for (const z of obj.zadania) if (z && Number.isInteger(z.id)) maxId = Math.max(maxId, z.id);

  const uzyteId = new Set();
  const zadania = [];
  obj.zadania.forEach((z, i) => {
    const nr = i + 1;
    if (!z || typeof z !== 'object' || Array.isArray(z)) {
      ostrzezenia.push(`Pozycja ${nr} pominięta – to nie jest zadanie.`);
      return;
    }
    const t = { ...z };

    if (!Number.isInteger(z.id) || uzyteId.has(z.id)) {
      t.id = ++maxId;
      ostrzezenia.push(`Zadanie ${nr}: brak lub powtórzone id – nadano id ${t.id}.`);
    }
    uzyteId.add(t.id);

    if (typeof z.tytul !== 'string' || !z.tytul.trim()) {
      t.tytul = '(bez tytułu)';
      ostrzezenia.push(`Zadanie ${nr}: brak tytułu.`);
    }
    t.opis = typeof z.opis === 'string' ? z.opis : '';

    if (z.termin === null || z.termin === undefined || z.termin === '') {
      t.termin = null;
    } else if (!poprawnaData(z.termin)) {
      ostrzezenia.push(`Zadanie ${nr}: niepoprawny termin "${z.termin}" – ustawiono brak terminu.`);
      t.termin = null;
    }

    if (!PRIORYTETY.includes(z.priorytet)) {
      ostrzezenia.push(`Zadanie ${nr}: nieznany priorytet "${z.priorytet}" – ustawiono "sredni".`);
      t.priorytet = 'sredni';
    }

    t.wykonane = z.wykonane === true;
    t.tagi = Array.isArray(z.tagi)
      ? z.tagi.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
      : [];

    zadania.push(uporzadkuj(t));
  });

  const { wersja: _w, zadania: _z, ...resztaPliku } = obj;
  return { dane: { wersja, zadania, ...resztaPliku }, ostrzezenia };
}

function wczytajZPliku(plik) {
  const czytnik = new FileReader();
  czytnik.onload = () => {
    let wynik;
    try {
      wynik = normalizuj(JSON.parse(czytnik.result));
    } catch (e) {
      powiadom(`Nie udało się wczytać pliku: ${e.message}`);
      return;
    }
    const poprzednie = { dane, sesje };
    dane = wynik.dane;
    sesje = {};          // nowe zadania = nowe id, więc stare odhaczone sesje nie pasują
    zapiszLokalnie();
    odswiez();
    let tekst = `Wczytano ${dane.zadania.length} zadań z pliku „${plik.name}”.`;
    if (wynik.ostrzezenia.length) {
      tekst += ` Poprawiono ${wynik.ostrzezenia.length} problem(ów) – szczegóły w konsoli.`;
      console.warn('Ostrzeżenia przy wczytywaniu:\n' + wynik.ostrzezenia.join('\n'));
    }
    powiadom(tekst, 'Cofnij', () => {
      dane = poprzednie.dane;
      sesje = poprzednie.sesje;
      zapiszLokalnie();
      odswiez();
    });
  };
  czytnik.onerror = () => powiadom('Nie udało się odczytać pliku.');
  czytnik.readAsText(plik, 'utf-8');
}

/** Zapis do pliku – dokładnie ten sam format: { "wersja": 1, "zadania": [...] } */
function zapiszDoPliku() {
  const tekst = JSON.stringify({ ...dane, zadania: dane.zadania.map(uporzadkuj) }, null, 2);
  const blob = new Blob([tekst + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'zadania.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  powiadom(`Zapisano ${dane.zadania.length} zadań do pliku zadania.json.`);
}

/* ---------- Autozapis w przeglądarce ---------- */
function zapiszLokalnie() {
  try {
    localStorage.setItem(KLUCZ_DANE, JSON.stringify(dane));
    localStorage.setItem(KLUCZ_SESJE, JSON.stringify(sesje));
  } catch (e) { /* np. tryb prywatny – aplikacja działa dalej, tylko bez autozapisu */ }
}
function wczytajLokalnie() {
  try {
    const d = localStorage.getItem(KLUCZ_DANE);
    if (d) {
      dane = normalizuj(JSON.parse(d)).dane;
      const s = JSON.parse(localStorage.getItem(KLUCZ_SESJE) || '{}');
      sesje = s && typeof s === 'object' ? s : {};
      return true;
    }
  } catch (e) { /* uszkodzone dane – zaczynamy od przykładu */ }
  return false;
}

/* =====================================================================
   SMART: pilność, plan sesji pracy, obciążenie dni
   ===================================================================== */

/** Pilność liczona z liczby dni do terminu. */
function pilnosc(z) {
  if (!z.termin) return 'spokojnie';
  const d = roznicaDni(DZIS, z.termin);
  if (d <= 1) return 'pilne';
  if (d <= 7) return 'wkrotce';
  return 'spokojnie';
}
function poTerminie(z) {
  return !z.wykonane && z.termin && z.termin < DZIS;
}

function zrobioneSesje(id) {
  return Array.isArray(sesje[id]) ? sesje[id] : [];
}

/**
 * Rozkłada pozostałe sesje pracy na dni przed terminem.
 * - Ile sesji: zależy od WAŻNOŚCI (wysoki 4, średni 2, niski 1).
 * - Jak gęsto: zależy od PILNOŚCI. Idealnie sesje są co drugi dzień
 *   w oknie kończącym się dzień przed terminem. Gdy czasu jest mało,
 *   okno się kurczy i kilka sesji wypada w tym samym dniu.
 * - Plan liczy się na nowo każdego dnia: pominięta sesja nie przepada,
 *   tylko "dociska" pozostałe dni (stąd ostrzeżenia o przeciążeniu).
 */
function planSesji(z) {
  if (z.wykonane || !z.termin) return [];
  // Tryb sesji egzaminacyjnej: powtórki same są nauką, a egzamin z powtórkami nie dostaje sesji.
  if (czyPowtorka(z)) return [];
  if (czyEgzamin(z) && powtorkiEgzaminu(z).length) return [];
  const potrzebne = SESJE_NA_PRIORYTET[z.priorytet] || 1;
  const zrobione = zrobioneSesje(z.id);
  const zostalo = Math.max(0, potrzebne - zrobione.length);
  if (zostalo === 0) return [];

  const doTerminu = roznicaDni(DZIS, z.termin);
  const start = zrobione.includes(DZIS) ? 1 : 0;   // dzisiejsza już zrobiona → zaczynamy od jutra
  let koniec = doTerminu - 1;                       // ostatni dzień przed terminem

  // Termin dziś albo już minął: nie ma dni "przed terminem", więc nie planujemy sesji.
  // Samo zadanie i tak liczy się do dzisiejszego obciążenia (i widać je jako pilne / zaległe).
  if (koniec < start) return [];

  const dni = [];
  {
    const okno = 2 * potrzebne;                     // np. 4 sesje → okno 8 dni (co drugi dzień)
    const poczatek = Math.max(start, koniec - okno + 1);
    const dlugosc = koniec - poczatek + 1;
    for (let i = 0; i < zostalo; i++) {
      dni.push(koniec - Math.floor(i * dlugosc / zostalo));
    }
    dni.reverse();
  }

  return dni.map((offset, i) => ({
    data: dodajDni(DZIS, offset),
    zadanie: z,
    nr: zrobione.length + i + 1,
    z: potrzebne,
  }));
}

/** Zbiera wszystko, co przypada na każdy dzień w horyzoncie planowania. */
function obciazenieDni() {
  const mapa = {};
  for (let i = 0; i < HORYZONT_DNI; i++) {
    mapa[dodajDni(DZIS, i)] = { punkty: 0, terminy: [], sesje: [] };
  }
  for (const z of dane.zadania) {
    if (z.wykonane) continue;
    if (z.termin) {
      const dzien = z.termin < DZIS ? DZIS : z.termin;   // zaległe liczą się do dziś
      if (mapa[dzien]) {
        mapa[dzien].terminy.push(z);
        mapa[dzien].punkty += czyPowtorka(z) ? PUNKTY_ZA_SESJE : PUNKTY_ZA_TERMIN[z.priorytet];
      }
    }
    for (const s of planSesji(z)) {
      if (mapa[s.data]) {
        mapa[s.data].sesje.push(s);
        mapa[s.data].punkty += PUNKTY_ZA_SESJE;
      }
    }
  }
  return mapa;
}

/** Najbliższy dzień (przed danym), w którym jest jeszcze miejsce. */
function luzniejszyDzien(mapa, data) {
  let najlepszy = null;
  for (const [d, info] of Object.entries(mapa)) {
    if (d === data || info.punkty + PUNKTY_ZA_SESJE > LIMIT_DNIA) continue;
    if (d > data) continue; // naukę opłaca się przesuwać wcześniej, nie później
    if (!najlepszy || Math.abs(roznicaDni(d, data)) < Math.abs(roznicaDni(najlepszy, data))) najlepszy = d;
  }
  return najlepszy;
}

function sesjaOdhaczona(id, data) {
  return zrobioneSesje(id).includes(data);
}

/* =====================================================================
   Operacje na zadaniach
   ===================================================================== */
function znajdz(id) {
  return dane.zadania.find(z => z.id === id);
}
function noweId() {
  return dane.zadania.reduce((m, z) => Math.max(m, z.id), 0) + 1;
}
function przelaczWykonane(id) {
  const z = znajdz(id);
  if (!z) return;
  z.wykonane = !z.wykonane;
  zapiszLokalnie();
  odswiez();
  if (z.wykonane) powiadom(`Zrobione: „${z.tytul}”`, 'Cofnij', () => przelaczWykonane(id));
}
function usun(id) {
  const indeks = dane.zadania.findIndex(z => z.id === id);
  if (indeks < 0) return;
  const [usuniete] = dane.zadania.splice(indeks, 1);
  const jegoSesje = sesje[id];
  delete sesje[id];
  zapiszLokalnie();
  odswiez();
  powiadom(`Usunięto „${usuniete.tytul}”`, 'Cofnij', () => {
    dane.zadania.splice(indeks, 0, usuniete);
    if (jegoSesje) sesje[id] = jegoSesje;
    zapiszLokalnie();
    odswiez();
  });
}
function przelaczSesje(id, data) {
  const lista = zrobioneSesje(id).slice();
  const i = lista.indexOf(data);
  if (i >= 0) lista.splice(i, 1); else lista.push(data);
  if (lista.length) sesje[id] = lista; else delete sesje[id];
  zapiszLokalnie();
  odswiez();
}

/* =====================================================================
   Wyświetlanie
   ===================================================================== */
const tresc = document.getElementById('tresc');

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function htmlAlarmu(mapa) {
  const przeciazone = Object.entries(mapa).filter(([, i]) => i.punkty > LIMIT_DNIA);
  if (!przeciazone.length) return '';
  const pozycje = przeciazone.map(([d, i]) => {
    const luz = luzniejszyDzien(mapa, d);
    const rada = luz
      ? `Zacznij część pracy wcześniej – np. <b>${ladnaData(luz)}</b> (${mapa[luz].punkty} pkt).`
      : 'Nie ma wcześniej wolnego dnia – rozważ przesunięcie mniej ważnego zadania.';
    return `<li><b>${d === DZIS ? 'Dziś' : ladnaData(d)}</b>: ${i.punkty} pkt (limit ${LIMIT_DNIA}). ${rada}</li>`;
  }).join('');
  return `
    <div class="alarm" role="alert">
      <strong>⚠ Alarm przeciążenia</strong> – w najbliższych ${HORYZONT_DNI} dniach ${przeciazone.length === 1 ? 'jeden dzień jest' : 'są dni'} zbyt napięt${przeciazone.length === 1 ? 'y' : 'e'}:
      <ul>${pozycje}</ul>
      ${widok !== 'terminarz' ? '<button class="przycisk maly" data-widok="terminarz">Zobacz w terminarzu</button>' : ''}
    </div>`;
}

function porownajTermin(a, b) {
  if (a.termin !== b.termin) {
    if (!a.termin) return 1;
    if (!b.termin) return -1;
    return a.termin < b.termin ? -1 : 1;
  }
  return WAGA_PRIORYTETU[b.priorytet] - WAGA_PRIORYTETU[a.priorytet];
}
function porownajWaznosc(a, b) {
  const r = WAGA_PRIORYTETU[b.priorytet] - WAGA_PRIORYTETU[a.priorytet];
  return r !== 0 ? r : porownajTermin(a, b);
}

/* ---------- Wszystkie zadania: kolumny z kafelkami ---------- */
const KOLUMNY = {
  pilnosc: [
    { klucz: 'pilne', nazwa: 'Pilne', opis: 'po terminie, dziś lub jutro' },
    { klucz: 'wkrotce', nazwa: 'Wkrótce', opis: '2–7 dni' },
    { klucz: 'spokojnie', nazwa: 'Spokojnie', opis: 'ponad tydzień lub bez terminu' },
  ],
  waznosc: [
    { klucz: 'wysoki', nazwa: 'Wysoka ważność', opis: 'priorytet wysoki' },
    { klucz: 'sredni', nazwa: 'Średnia ważność', opis: 'priorytet średni' },
    { klucz: 'niski', nazwa: 'Niska ważność', opis: 'priorytet niski' },
  ],
};

function htmlKafelka(z) {
  return `
    <li>
      <button class="kafelek p-${z.priorytet} ${z.wykonane ? 'zrobiony' : ''}" data-akcja="szczegoly" data-id="${z.id}">
        <span class="kafelek-tytul">${esc(z.tytul)}</span>
        <span class="kafelek-podtytul ${z.wykonane ? '' : pilnosc(z)}">${z.wykonane ? 'zrobione' : esc(opisTerminu(z.termin))}</span>
      </button>
    </li>`;
}

function htmlKolumny(klucz, nazwa, opis, zadania) {
  return `
    <section class="kol kol-${klucz}">
      <header class="kol-gora">
        <span class="kol-nazwa">${nazwa}</span>
        <span class="licznik">${zadania.length}</span>
      </header>
      <div class="kol-opis">${opis}</div>
      ${zadania.length
        ? `<ul class="kafelki">${zadania.map(htmlKafelka).join('')}</ul>`
        : '<div class="kolumna-pusta">Pusto</div>'}
    </section>`;
}

function widokWszystkie() {
  const tagi = [...new Set(dane.zadania.flatMap(z => z.tagi))].sort((a, b) => a.localeCompare(b, 'pl'));
  const fraza = filtry.szukaj.trim().toLowerCase();
  const pasuje = z =>
    (!filtry.tag || z.tagi.includes(filtry.tag)) &&
    (!fraza || (z.tytul + ' ' + z.opis + ' ' + z.tagi.join(' ')).toLowerCase().includes(fraza));

  const aktywne = dane.zadania.filter(z => !z.wykonane && pasuje(z)).sort(porownajTermin);
  const zrobione = dane.zadania.filter(z => z.wykonane && pasuje(z)).sort(porownajTermin);
  const ileZrobionych = dane.zadania.filter(z => z.wykonane).length;

  const grupa = filtry.grupuj === 'waznosc' ? (z => z.priorytet) : pilnosc;
  let kolumny = KOLUMNY[filtry.grupuj].map(k =>
    htmlKolumny(k.klucz, k.nazwa, k.opis, aktywne.filter(z => grupa(z) === k.klucz)));
  if (filtry.pokazZrobione) kolumny.push(htmlKolumny('zrobione', 'Zrobione', 'odhaczone zadania', zrobione));

  const pasek = `
    <div class="filtry">
      <div class="przelacznik" role="group" aria-label="Układ kolumn">
        <span class="maly-tekst">Kolumny wg:</span>
        <button class="${filtry.grupuj === 'pilnosc' ? 'wl' : ''}" data-akcja="grupuj" data-wartosc="pilnosc">Pilności</button>
        <button class="${filtry.grupuj === 'waznosc' ? 'wl' : ''}" data-akcja="grupuj" data-wartosc="waznosc">Ważności</button>
      </div>
      <input type="search" data-filtr="szukaj" placeholder="Szukaj…" value="${esc(filtry.szukaj)}" aria-label="Szukaj">
      <select data-filtr="tag" aria-label="Tag">
        <option value="">Wszystkie tagi</option>
        ${tagi.map(t => `<option value="${esc(t)}" ${filtry.tag === t ? 'selected' : ''}>#${esc(t)}</option>`).join('')}
      </select>
      <label class="pokaz-zrobione">
        <input type="checkbox" data-akcja="pokaz-zrobione" ${filtry.pokazZrobione ? 'checked' : ''}>
        Pokaż zrobione (${ileZrobionych})
      </label>
    </div>`;

  if (!dane.zadania.length) {
    return pasek + `<div class="pusto">Nie masz jeszcze żadnych zadań.<br>
      <button class="przycisk glowny" data-akcja="nowe">+ Dodaj pierwsze zadanie</button>
      <button class="przycisk" data-akcja="wczytaj">Wczytaj plik JSON</button></div>`;
  }
  return pasek + `<div class="tablica ${filtry.pokazZrobione ? 'cztery' : ''}">${kolumny.join('')}</div>
    <p class="maly-tekst tydzien-stopka">W kolumnie zadania są ułożone według terminu. Kliknij kafelek, aby zobaczyć szczegóły.</p>`;
}

/* ---------- Okno szczegółów zadania ---------- */
const oknoSzczegoly = document.getElementById('szczegoly');

function pokazSzczegoly(id) {
  const z = znajdz(id);
  if (!z) { if (oknoSzczegoly.open) oknoSzczegoly.close(); return; }
  szczegolyId = id;
  const p = pilnosc(z);
  const plan = planSesji(z);
  const potrzebne = SESJE_NA_PRIORYTET[z.priorytet];
  let planHtml;
  const powtorki = czyEgzamin(z) ? powtorkiEgzaminu(z) : [];
  if (z.wykonane) planHtml = 'Zadanie zrobione.';
  else if (czyPowtorka(z)) planHtml = 'To powtórka przed egzaminem (tryb sesji) – sama jest sesją nauki.';
  else if (powtorki.length) planHtml = `Powtórki: ${powtorki.filter(x => x.wykonane).length} z ${powtorki.length} zrobione · ` + powtorki.map(x => (x.wykonane ? '✓ ' : '') + ladnaData(x.termin)).join(' · ');
  else if (!z.termin) planHtml = 'Bez terminu – nie da się zaplanować sesji. Zrób je w luźniejszy dzień.';
  else if (!plan.length && zrobioneSesje(z.id).length >= potrzebne) planHtml = `Wszystkie sesje pracy (${potrzebne}) zrobione.`;
  else if (!plan.length) planHtml = 'Termin jest dziś lub minął – nie planujemy już sesji, czas działać.';
  else planHtml = `${plan.length} z ${potrzebne} sesji do zrobienia: ` + plan.map(s => s.data === DZIS ? 'dziś' : ladnaData(s.data)).join(' · ');

  document.getElementById('szczegoly-tresc').innerHTML = `
    <div class="szcz-gora">
      <h2 class="${z.wykonane ? 'przekreslone' : ''}">${esc(z.tytul)}</h2>
      <button type="button" class="ikona" data-akcja="zamknij-szczegoly" aria-label="Zamknij">✕</button>
    </div>
    ${z.opis ? `<p class="szcz-opis">${esc(z.opis)}</p>` : '<p class="szcz-opis maly-tekst">Brak opisu.</p>'}
    <dl class="szcz-lista">
      <dt>Termin</dt><dd>${!z.termin ? 'bez terminu' : roznicaDni(DZIS, z.termin) > 1 ? esc(opisTerminu(z.termin)) : esc(ladnaData(z.termin)) + ' · ' + esc(opisTerminu(z.termin))}</dd>
      <dt>Ważność</dt><dd><span class="znaczek w-${z.priorytet}">${NAZWA_PRIORYTETU[z.priorytet]}</span></dd>
      <dt>Pilność</dt><dd>${z.wykonane ? '–' : `<span class="znaczek ${p}">${NAZWA_PILNOSCI[p]}</span>`}</dd>
      <dt>Tagi</dt><dd>${z.tagi.length ? z.tagi.map(t => `<span class="znaczek tag">#${esc(t)}</span>`).join(' ') : '–'}</dd>
      <dt>Status</dt><dd>${z.wykonane ? '✓ Zrobione' : 'Do zrobienia'}</dd>
      <dt>Plan pracy</dt><dd>${planHtml}</dd>
    </dl>
    <div class="okno-stopka szcz-stopka">
      <button type="button" class="przycisk usun-przycisk" data-akcja="usun" data-id="${z.id}">Usuń</button>
      <span style="flex:1"></span>
      <button type="button" class="przycisk" data-akcja="edytuj" data-id="${z.id}">Edytuj</button>
      <button type="button" class="przycisk glowny" data-akcja="odhacz" data-id="${z.id}">${z.wykonane ? 'Cofnij wykonanie' : '✓ Oznacz jako zrobione'}</button>
    </div>`;
  if (!oknoSzczegoly.open) oknoSzczegoly.showModal();
}
oknoSzczegoly.addEventListener('close', () => { szczegolyId = null; });
oknoSzczegoly.addEventListener('click', e => { if (e.target === oknoSzczegoly) oknoSzczegoly.close(); });

/* =====================================================================
   TERMINARZ – kalendarz: tydzień / 2 tygodnie / miesiąc
   Siatka zawsze od poniedziałku. Im więcej dni, tym mniejsze kratki:
   tydzień i 2 tygodnie pokazują nazwy zadań, miesiąc – kolorowe kropki
   (kolor = pilność). Kliknięcie zadania lub kropki otwiera szczegóły.
   ===================================================================== */
const terminarz = { zakres: 'tydzien', przesuniecie: 0, pokazSesje: true };
const NAZWY_DNI = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];

function poniedzialek(s) {
  return dodajDni(s, -((zISO(s).getDay() + 6) % 7));
}

function zakresTerminarza() {
  const pon = poniedzialek(DZIS);
  if (terminarz.zakres === 'tydzien') return { start: dodajDni(pon, 7 * terminarz.przesuniecie), dni: 7 };
  if (terminarz.zakres === '2tyg') return { start: dodajDni(pon, 14 * terminarz.przesuniecie), dni: 14 };
  const t = zISO(DZIS);
  const pierwszy = new Date(t.getFullYear(), t.getMonth() + terminarz.przesuniecie, 1);
  const ostatni = new Date(pierwszy.getFullYear(), pierwszy.getMonth() + 1, 0);
  const start = poniedzialek(naISO(pierwszy));
  const koniec = dodajDni(poniedzialek(naISO(ostatni)), 6);
  return { start, dni: roznicaDni(start, koniec) + 1, miesiac: pierwszy.getMonth(), pierwszy };
}

/** Terminy, sesje pracy i punkty obciążenia dla każdego dnia w zakresie. */
function daneKalendarza(start, dni) {
  const mapa = {};
  for (let i = 0; i < dni; i++) mapa[dodajDni(start, i)] = { terminy: [], sesje: [], punkty: 0 };
  for (const z of dane.zadania) {
    if (z.wykonane) continue;
    if (z.termin) {
      const dzien = z.termin < DZIS ? DZIS : z.termin;   // zaległe pokazujemy dziś
      if (mapa[dzien]) {
        mapa[dzien].terminy.push(z);
        mapa[dzien].punkty += czyPowtorka(z) ? PUNKTY_ZA_SESJE : PUNKTY_ZA_TERMIN[z.priorytet];
      }
    }
    for (const s of planSesji(z)) {
      if (mapa[s.data]) { mapa[s.data].sesje.push(s); mapa[s.data].punkty += PUNKTY_ZA_SESJE; }
    }
    // sesje odhaczone (np. dziś) – pokazujemy jako zrobione
    zrobioneSesje(z.id).forEach((d, i) => {
      if (mapa[d]) mapa[d].sesje.push({ data: d, zadanie: z, nr: i + 1, z: SESJE_NA_PRIORYTET[z.priorytet], zrobiona: true });
    });
  }
  for (const info of Object.values(mapa)) {
    info.terminy.sort((a, b) => (WAGA_PRIORYTETU[b.priorytet] - WAGA_PRIORYTETU[a.priorytet]) || porownajTermin(a, b));
    info.sesje.sort((a, b) => (a.zrobiona ? 1 : 0) - (b.zrobiona ? 1 : 0));
  }
  return mapa;
}

function htmlTerminuKal(z) {
  const zalegle = z.termin < DZIS;
  return `
    <li class="karta p-${z.priorytet}">
      <button class="odhacz maly-odhacz" data-akcja="odhacz" data-id="${z.id}" title="Oznacz jako zrobione" aria-label="Oznacz jako zrobione"></button>
      <button class="karta-tresc" data-akcja="szczegoly" data-id="${z.id}" title="Pokaż szczegóły">
        <span class="karta-tytul">${esc(z.tytul)}</span>
        ${zalegle ? `<span class="znaczek pilne">zaległe · ${esc(ladnaData(z.termin, false))}</span>` : ''}
      </button>
    </li>`;
}

function htmlSesjiKal(s) {
  const dzis = s.data === DZIS;
  const zrobiona = !!s.zrobiona;
  return `
    <li class="sesja-kal ${zrobiona ? 'zrobiona' : ''}">
      ${dzis ? `<button class="odhacz maly-odhacz kwadrat" data-akcja="sesja" data-id="${s.zadanie.id}" data-data="${s.data}"
        title="${zrobiona ? 'Cofnij' : 'Odhacz sesję'}" aria-label="Odhacz sesję">${zrobiona ? '✓' : ''}</button>` : '<span class="sesja-znak"></span>'}
      <button class="karta-tresc" data-akcja="szczegoly" data-id="${s.zadanie.id}" title="Sesja pracy – pokaż zadanie">
        <span class="karta-tytul">Sesja ${s.nr}/${s.z}: ${esc(s.zadanie.tytul)}</span>
      </button>
    </li>`;
}

function htmlKropek(info) {
  const kropki = info.terminy.map(z => {
    const p = pilnosc(z);
    return `<button class="kropka-kal ${p}" data-akcja="szczegoly" data-id="${z.id}"
      title="${esc(z.tytul)} (${NAZWA_PILNOSCI[p].toLowerCase()})" aria-label="${esc(z.tytul)}"></button>`;
  });
  if (terminarz.pokazSesje) {
    for (const s of info.sesje) {
      kropki.push(`<button class="kropka-kal sesja ${s.zrobiona ? 'zrobiona' : ''}" data-akcja="szczegoly" data-id="${s.zadanie.id}"
        title="Sesja ${s.nr}/${s.z}: ${esc(s.zadanie.tytul)}" aria-label="Sesja: ${esc(s.zadanie.tytul)}"></button>`);
    }
  }
  return kropki.length ? `<div class="kropki">${kropki.join('')}</div>` : '';
}

function htmlDniaKal(d, info, tryb, zakres) {
  const data = zISO(d);
  const przeszly = d < DZIS;
  const poza = tryb === 'miesiac' && data.getMonth() !== zakres.miesiac;
  const przeciazony = !przeszly && info.punkty > LIMIT_DNIA;
  const klasy = ['dzien-kal', d === DZIS && 'dzisiaj', przeszly && 'przeszly', poza && 'poza', przeciazony && 'przeciazony'].filter(Boolean).join(' ');

  let naglowek;
  if (tryb === 'tydzien') {
    naglowek = `<span class="kal-dzien">${d === DZIS ? 'Dziś' : esc(data.toLocaleDateString('pl-PL', { weekday: 'long' }))}</span>
      <span class="kal-data">${esc(data.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }))}</span>`;
  } else {
    const nr = data.getDate();
    const mies = (nr === 1 || d === zakres.start) ? ' ' + esc(data.toLocaleDateString('pl-PL', { month: 'short' })) : '';
    naglowek = `<span class="kal-nr">${nr}${mies}</span>`;
  }

  const proc = Math.min(100, Math.round(info.punkty / LIMIT_DNIA * 100));
  const klasaPaska = info.punkty > LIMIT_DNIA ? 'pelny' : info.punkty >= LIMIT_DNIA - 1 ? 'sredni' : '';
  const pasek = !przeszly && info.punkty > 0
    ? `<div class="pasek kal-pasek ${klasaPaska}" title="Obciążenie: ${info.punkty}/${LIMIT_DNIA} pkt"><div style="width:${proc}%"></div></div>` : '';

  let srodek;
  if (tryb === 'miesiac') {
    srodek = htmlKropek(info);
  } else {
    const pozycje = [
      ...info.terminy.map(htmlTerminuKal),
      ...(terminarz.pokazSesje ? info.sesje.map(htmlSesjiKal) : []),
    ];
    srodek = pozycje.length ? `<ul class="karty">${pozycje.join('')}</ul>` : '';
  }

  const dodaj = tryb === 'miesiac' || przeszly ? ''
    : `<button class="dodaj-w-dniu" data-akcja="nowe" data-data="${d}" title="Dodaj zadanie na ten dzień">${tryb === 'tydzien' ? '+ Dodaj' : '+'}</button>`;

  return `
    <div class="${klasy}">
      <div class="kal-gora">${naglowek}${przeciazony ? '<span class="kal-alarm" title="Dzień przeciążony">⚠</span>' : ''}</div>
      ${pasek}
      ${srodek}
      ${dodaj}
    </div>`;
}

function widokTerminarz() {
  const zakres = zakresTerminarza();
  const tryb = terminarz.zakres === 'miesiac' ? 'miesiac' : terminarz.zakres === '2tyg' ? 'dwa' : 'tydzien';
  const mapa = daneKalendarza(zakres.start, zakres.dni);
  const koniec = dodajDni(zakres.start, zakres.dni - 1);

  const tytul = tryb === 'miesiac'
    ? (t => t.charAt(0).toUpperCase() + t.slice(1))(zakres.pierwszy.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' }))
    : `${ladnaData(zakres.start, false)} – ${ladnaData(koniec, false)} ${zISO(koniec).getFullYear()}`;

  const przycisk = (w, n) => `<button class="${terminarz.zakres === w ? 'wl' : ''}" data-akcja="zakres" data-wartosc="${w}">${n}</button>`;
  const pasekNarzedzi = `
    <div class="filtry term-pasek">
      <div class="przelacznik" role="group" aria-label="Zakres">
        ${przycisk('tydzien', 'Tydzień')}${przycisk('2tyg', '2 tygodnie')}${przycisk('miesiac', 'Miesiąc')}
      </div>
      <div class="term-nawigacja">
        <button class="przycisk maly" data-akcja="przesun" data-wartosc="-1" aria-label="Wcześniej">←</button>
        <button class="przycisk maly" data-akcja="przesun" data-wartosc="0" ${terminarz.przesuniecie === 0 ? 'disabled' : ''}>Dziś</button>
        <button class="przycisk maly" data-akcja="przesun" data-wartosc="1" aria-label="Później">→</button>
      </div>
      <strong class="term-tytul">${esc(tytul)}</strong>
      <label class="pokaz-zrobione">
        <input type="checkbox" data-akcja="pokaz-sesje" ${terminarz.pokazSesje ? 'checked' : ''}> Sesje pracy
      </label>
    </div>`;

  const naglowkiDni = tryb === 'tydzien' ? '' : `<div class="kal-naglowki">${NAZWY_DNI.map(n => `<span>${n}</span>`).join('')}</div>`;
  const komorki = Object.entries(mapa).map(([d, info]) => htmlDniaKal(d, info, tryb, zakres)).join('');

  const legenda = tryb === 'miesiac'
    ? `<span class="legenda"><i class="kropka-kal pilne"></i> pilne <i class="kropka-kal wkrotce"></i> wkrótce <i class="kropka-kal spokojnie"></i> spokojnie
       ${terminarz.pokazSesje ? '<i class="kropka-kal sesja"></i> sesja pracy' : ''}</span> Kliknij kropkę, aby zobaczyć zadanie.`
    : 'Kolor paska przy zadaniu = ważność. Kliknij zadanie, aby zobaczyć szczegóły, a kółko – aby je odhaczyć. Sesje pracy są w przerywanej ramce.';
  const bezTerminu = dane.zadania.filter(z => !z.wykonane && !z.termin).length;

  return pasekNarzedzi + naglowkiDni +
    `<div class="kal kal-${tryb}">${komorki}</div>
     <p class="maly-tekst tydzien-stopka">${legenda}
       ${bezTerminu ? ` · Bez terminu: ${bezTerminu} zad. <button class="link" data-widok="wszystkie">zobacz →</button>` : ''}</p>`;
}

/* =====================================================================
   TRYB SESJI EGZAMINACYJNEJ
   Egzamin = zwykłe zadanie z tagiem #egzamin.
   Powtórki = zwykłe zadania z tagiem #powtórka i tytułem
   "Powtórka 2/5 – <tytuł egzaminu>" (po tytule wiemy, do którego egzaminu należą).
   Dzięki temu wszystko zapisuje się w pliku JSON w tym samym formacie.
   Powtórki są coraz gęściej przed egzaminem (powtórki w odstępach):
   np. 14, 7, 4, 2 i 1 dzień przed egzaminem.
   ===================================================================== */
const TAG_EGZAMIN = 'egzamin';
const TAG_POWTORKA = 'powtórka';
const ODSTEPY_POWTOREK = [1, 2, 4, 7, 14, 21, 30];   // dni przed egzaminem
const formEgz = { przedmiot: '', data: '', opis: '', ile: '5', priorytet: 'wysoki' };

function czyEgzamin(z) { return z.tagi.includes(TAG_EGZAMIN); }
function czyPowtorka(z) { return z.tagi.includes(TAG_POWTORKA); }
function powtorkiEgzaminu(e) {
  const koncowka = ' – ' + e.tytul;
  return dane.zadania.filter(z => z.id !== e.id && czyPowtorka(z) && z.tytul.endsWith(koncowka)).sort(porownajTermin);
}

/** Daty powtórek: coraz gęściej przed egzaminem, tylko od dziś wzwyż. */
function terminyPowtorek(dataEgzaminu, ile) {
  const doEgzaminu = roznicaDni(DZIS, dataEgzaminu);
  if (doEgzaminu < 1) return [];
  const odstepy = ODSTEPY_POWTOREK.slice(0, ile).filter(o => o <= doEgzaminu);
  // za mało czasu na idealny rozkład → dokładamy wolne dni najbliżej egzaminu
  for (let o = 1; o <= doEgzaminu && odstepy.length < ile; o++) {
    if (!odstepy.includes(o)) odstepy.push(o);
  }
  return odstepy.sort((a, b) => b - a).map(o => dodajDni(dataEgzaminu, -o));
}

function dodajPowtorki(egzamin, ile) {
  const daty = terminyPowtorek(egzamin.termin, ile);
  daty.forEach((d, i) => {
    dane.zadania.push(uporzadkuj({
      id: noweId(),
      tytul: `Powtórka ${i + 1}/${daty.length} – ${egzamin.tytul}`,
      opis: `Powtórka materiału przed egzaminem (${ladnaData(egzamin.termin)}).`,
      termin: d,
      priorytet: egzamin.priorytet,
      wykonane: false,
      tagi: [TAG_POWTORKA],
    }));
  });
  return daty.length;
}

function dodajEgzamin() {
  const przedmiot = formEgz.przedmiot.trim();
  const blad = document.getElementById('blad-egz');
  if (!przedmiot) { blad.textContent = 'Podaj przedmiot.'; return; }
  if (!poprawnaData(formEgz.data) || roznicaDni(DZIS, formEgz.data) < 1) {
    blad.textContent = 'Podaj datę egzaminu – najwcześniej jutro.'; return;
  }
  const tytul = /^egzamin/i.test(przedmiot) ? przedmiot : `Egzamin: ${przedmiot}`;
  if (dane.zadania.some(z => czyEgzamin(z) && z.tytul === tytul)) {
    blad.textContent = 'Taki egzamin już jest na liście.'; return;
  }
  const egzamin = uporzadkuj({
    id: noweId(), tytul, opis: formEgz.opis.trim(), termin: formEgz.data,
    priorytet: formEgz.priorytet, wykonane: false, tagi: [TAG_EGZAMIN],
  });
  dane.zadania.push(egzamin);
  const ile = dodajPowtorki(egzamin, Number(formEgz.ile));
  Object.assign(formEgz, { przedmiot: '', data: '', opis: '' });
  zapiszLokalnie();
  odswiez();
  powiadom(`Dodano „${tytul}” i ${ile} powtórek.`);
}

function zaplanujPowtorki(id) {
  const e = znajdz(id);
  if (!e || !e.termin) return;
  const ile = dodajPowtorki(e, 5);
  zapiszLokalnie();
  odswiez();
  powiadom(ile ? `Zaplanowano ${ile} powtórek do „${e.tytul}”.` : 'Za mało czasu do egzaminu, żeby zaplanować powtórki.');
}

function usunEgzamin(id) {
  const e = znajdz(id);
  if (!e) return;
  const doUsuniecia = new Set([id, ...powtorkiEgzaminu(e).map(z => z.id)]);
  const poprzednie = dane.zadania.slice();
  dane.zadania = dane.zadania.filter(z => !doUsuniecia.has(z.id));
  for (const x of doUsuniecia) delete sesje[x];
  zapiszLokalnie();
  odswiez();
  powiadom(`Usunięto „${e.tytul}” razem z powtórkami.`, 'Cofnij', () => {
    dane.zadania = poprzednie;
    zapiszLokalnie();
    odswiez();
  });
}

function podgladEgzaminu() {
  const el = document.getElementById('podglad-egz');
  if (!el) return;
  if (!poprawnaData(formEgz.data)) { el.innerHTML = 'Wybierz datę egzaminu, a pokażę plan powtórek.'; return; }
  const doEgz = roznicaDni(DZIS, formEgz.data);
  if (doEgz < 1) { el.innerHTML = 'Egzamin musi być najwcześniej jutro.'; return; }
  const daty = terminyPowtorek(formEgz.data, Number(formEgz.ile));
  el.innerHTML = `Do egzaminu: <b>${doEgz} dni</b>. Powtórki (${daty.length}): ` +
    daty.map(d => `<span class="znaczek tag">${esc(d === DZIS ? 'dziś' : ladnaData(d))}</span>`).join(' ');
}

function htmlEgzaminu(e) {
  const powtorki = powtorkiEgzaminu(e);
  const zrobione = powtorki.filter(z => z.wykonane).length;
  const proc = powtorki.length ? Math.round(zrobione / powtorki.length * 100) : 0;
  const doEgz = e.termin ? roznicaDni(DZIS, e.termin) : null;
  const odliczanie = doEgz === null ? 'bez daty' : doEgz === 0 ? 'DZIŚ' : doEgz === 1 ? 'jutro' : `za ${doEgz} dni`;

  const chipy = powtorki.map(z => {
    const zalegla = !z.wykonane && z.termin < DZIS;
    return `<button class="powtorka ${z.wykonane ? 'zrobiona' : ''} ${zalegla ? 'zalegla' : ''} ${z.termin === DZIS ? 'dzis' : ''}"
      data-akcja="odhacz" data-id="${z.id}" title="${z.wykonane ? 'Cofnij' : 'Odhacz powtórkę'}">
      <span class="powtorka-znak">${z.wykonane ? '✓' : ''}</span>${esc(z.termin === DZIS ? 'dziś' : ladnaData(z.termin))}</button>`;
  }).join('');

  let dol;
  if (powtorki.length) {
    dol = `
      <div class="egz-postep">
        <div class="pasek"><div style="width:${proc}%"></div></div>
        <span class="maly-tekst">Powtórki: ${zrobione}/${powtorki.length}</span>
      </div>
      <div class="powtorki">${chipy}</div>`;
  } else if (e.termin && doEgz >= 1) {
    dol = `<p class="maly-tekst">Ten egzamin nie ma jeszcze powtórek.</p>
      <button class="przycisk maly" data-akcja="zaplanuj-powtorki" data-id="${e.id}">Zaplanuj 5 powtórek</button>`;
  } else {
    dol = '<p class="maly-tekst">Brak daty lub za mało czasu, żeby zaplanować powtórki.</p>';
  }

  return `
    <article class="egzamin p-${e.priorytet}">
      <div class="egz-gora">
        <div>
          <button class="egz-tytul" data-akcja="szczegoly" data-id="${e.id}">${esc(e.tytul)}</button>
          <div class="maly-tekst">${e.termin ? esc(ladnaData(e.termin)) : 'bez daty'}${e.opis ? ' · ' + esc(e.opis) : ''}</div>
        </div>
        <div class="odliczanie ${doEgz !== null && doEgz <= 3 ? 'blisko' : ''}">${odliczanie}</div>
      </div>
      ${dol}
      <div class="egz-akcje">
        <button class="ikona usun" data-akcja="usun-egzamin" data-id="${e.id}">Usuń egzamin z powtórkami</button>
      </div>
    </article>`;
}

function widokSesja() {
  const egzaminy = dane.zadania.filter(z => czyEgzamin(z)).sort(porownajTermin);
  const nadchodzace = egzaminy.filter(e => !e.wykonane && (!e.termin || e.termin >= DZIS));
  const zakonczone = egzaminy.filter(e => e.wykonane || (e.termin && e.termin < DZIS));
  const opcjeIle = [3, 4, 5, 6, 7].map(n => `<option value="${n}" ${formEgz.ile == n ? 'selected' : ''}>${n}</option>`).join('');

  let html = `
    <section class="sekcja">
      <h2>Tryb sesji egzaminacyjnej</h2>
      <form id="form-egz" class="egz-form" autocomplete="off">
        <label class="pole"><span>Przedmiot *</span>
          <input data-egz="przedmiot" type="text" maxlength="150" placeholder="np. Analiza matematyczna" value="${esc(formEgz.przedmiot)}"></label>
        <label class="pole"><span>Data egzaminu *</span>
          <input data-egz="data" type="date" min="${dodajDni(DZIS, 1)}" value="${esc(formEgz.data)}"></label>
        <label class="pole"><span>Zakres / uwagi</span>
          <input data-egz="opis" type="text" maxlength="300" placeholder="np. wykłady 1–8, sala 204" value="${esc(formEgz.opis)}"></label>
        <label class="pole"><span>Liczba powtórek</span>
          <select data-egz="ile">${opcjeIle}</select></label>
        <label class="pole"><span>Ważność</span>
          <select data-egz="priorytet">
            ${PRIORYTETY.slice().reverse().map(p => `<option value="${p}" ${formEgz.priorytet === p ? 'selected' : ''}>${NAZWA_PRIORYTETU[p]}</option>`).join('')}
          </select></label>
        <div class="egz-form-dol">
          <div id="podglad-egz" class="podglad-planu"></div>
          <small class="blad" id="blad-egz"></small>
          <button type="submit" class="przycisk glowny">Dodaj egzamin i zaplanuj powtórki</button>
        </div>
      </form>
      <p class="maly-tekst">Powtórki są coraz gęściej przed egzaminem (np. 14, 7, 4, 2 i 1 dzień przed) – tak działa nauka z powtórkami w odstępach.
        Każda powtórka to zwykłe zadanie z tagiem #powtórka, więc widać je w kalendarzu i zapisują się w pliku JSON.</p>
    </section>`;

  html += `<section class="sekcja"><h2>Nadchodzące egzaminy <span class="licznik">${nadchodzace.length}</span></h2>`;
  html += nadchodzace.length
    ? `<div class="egzaminy">${nadchodzace.map(htmlEgzaminu).join('')}</div>`
    : '<div class="pusto">Brak egzaminów. Dodaj pierwszy formularzem powyżej – albo oznacz zwykłe zadanie tagiem #egzamin.</div>';
  html += '</section>';
  if (zakonczone.length) {
    html += `<section class="sekcja"><h2>Zakończone <span class="licznik">${zakonczone.length}</span></h2>
      <div class="egzaminy zakonczone">${zakonczone.map(htmlEgzaminu).join('')}</div></section>`;
  }
  return html;
}

// Formularz egzaminu: zapamiętujemy wpisane wartości (widok odświeża się po każdej zmianie danych)
tresc.addEventListener('input', e => {
  const k = e.target.dataset.egz;
  if (!k) return;
  formEgz[k] = e.target.value;
  const blad = document.getElementById('blad-egz');
  if (blad) blad.textContent = '';
  podgladEgzaminu();
});
tresc.addEventListener('submit', e => {
  if (e.target.id !== 'form-egz') return;
  e.preventDefault();
  dodajEgzamin();
});

/* ---------- Zakładka "Alarmy": przeciążone dni ---------- */
function dniPrzeciazone(mapa) {
  return Object.entries(mapa).filter(([, i]) => i.punkty > LIMIT_DNIA);
}

function widokAlarmy(mapa) {
  const przeciazone = dniPrzeciazone(mapa);
  let html = '';
  if (przeciazone.length) {
    html += htmlAlarmu(mapa);
  } else {
    html += `<div class="ok-box"><strong>✓ Brak przeciążeń</strong> – w najbliższych ${HORYZONT_DNI} dniach żaden dzień nie przekracza ${LIMIT_DNIA} pkt.</div>`;
  }

  const liniaLimitu = Math.round(LIMIT_DNIA / (LIMIT_DNIA * 1.6) * 100);
  const slupki = Object.entries(mapa).map(([d, info]) => {
    const wys = Math.min(100, Math.round(info.punkty / (LIMIT_DNIA * 1.6) * 100));
    const klasa = info.punkty > LIMIT_DNIA ? 'pelny' : info.punkty >= LIMIT_DNIA - 1 ? 'sredni' : '';
    const z = zISO(d);
    return `
      <div class="slupek ${klasa}" title="${esc(ladnaData(d))}: ${info.punkty} pkt">
        <span class="slupek-wartosc">${info.punkty}</span>
        <div class="slupek-tor"><div style="height:${wys}%"></div><i class="limit" style="bottom:${liniaLimitu}%"></i></div>
        <span class="slupek-dzien">${d === DZIS ? 'dziś' : esc(z.toLocaleDateString('pl-PL', { weekday: 'short' }))}</span>
        <span class="slupek-data">${z.getDate()}.${String(z.getMonth() + 1).padStart(2, '0')}</span>
      </div>`;
  }).join('');

  html += `
    <section class="sekcja">
      <h2>Obciążenie na ${HORYZONT_DNI} dni <span class="maly-tekst" style="text-transform:none;letter-spacing:0">· przerywana linia = limit ${LIMIT_DNIA} pkt</span></h2>
      <div class="wykres">
        ${slupki}
      </div>
    </section>
    <section class="sekcja">
      <h2>Jak liczymy punkty?</h2>
      <div class="obciazenie maly-tekst" style="color:var(--tekst)">
        Termin zadania: <b>wysoki 3 pkt</b>, <b>średni 2 pkt</b>, <b>niski 1 pkt</b> · każda sesja pracy: <b>1 pkt</b>.<br>
        Dzień powyżej <b>${LIMIT_DNIA} pkt</b> jest przeciążony – wtedy podpowiadamy wcześniejszy, luźniejszy dzień,
        żeby zacząć pracę zawczasu zamiast robić wszystko na ostatnią chwilę.
      </div>
    </section>`;
  return html;
}

function odswiez() {
  const mapa = obciazenieDni();
  const fokus = document.activeElement?.dataset?.filtr;   // nie gubimy kursora w wyszukiwarce

  if (oknoSzczegoly.open && szczegolyId !== null) pokazSzczegoly(szczegolyId);
  if (widok === 'sesja') setTimeout(podgladEgzaminu, 0);

  if (widok === 'terminarz') tresc.innerHTML = widokTerminarz();
  else if (widok === 'alarmy') tresc.innerHTML = widokAlarmy(mapa);
  else if (widok === 'sesja') tresc.innerHTML = widokSesja();
  else tresc.innerHTML = widokWszystkie();

  if (fokus) {
    const pole = tresc.querySelector(`[data-filtr="${fokus}"]`);
    if (pole) { pole.focus(); if (pole.setSelectionRange && pole.type === 'search') pole.setSelectionRange(pole.value.length, pole.value.length); }
  }

  document.querySelectorAll('.zakladka').forEach(b => b.classList.toggle('aktywna', b.dataset.widok === widok));

  // licznik przeciążonych dni na zakładce "Alarmy"
  const ileAlarmow = dniPrzeciazone(mapa).length;
  const plakietka = document.getElementById('plakietka-alarmy');
  plakietka.textContent = ileAlarmow;
  plakietka.hidden = ileAlarmow === 0;

  const aktywne = dane.zadania.filter(z => !z.wykonane).length;
  const zalegle = dane.zadania.filter(poTerminie).length;
  const zrobione = dane.zadania.length - aktywne;
  document.getElementById('podtytul').textContent =
    `${ladnaData(DZIS)} · do zrobienia: ${aktywne}` + (zalegle ? ` · po terminie: ${zalegle}` : '') + ` · zrobione: ${zrobione}`;
}

/* =====================================================================
   Formularz dodawania / edycji
   ===================================================================== */
const okno = document.getElementById('okno');
const formularz = document.getElementById('formularz');

function zbierzFormularz() {
  const f = new FormData(formularz);
  return {
    tytul: (f.get('tytul') || '').trim(),
    opis: (f.get('opis') || '').trim(),
    termin: f.get('termin') || null,
    priorytet: f.get('priorytet') || 'sredni',
    tagi: [...new Set((f.get('tagi') || '').split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean))],
  };
}

function podgladPlanu() {
  const w = zbierzFormularz();
  const el = document.getElementById('podglad-planu');
  if (!w.termin || !poprawnaData(w.termin)) {
    el.innerHTML = 'Dodaj termin, a aplikacja sama rozłoży sesje pracy na dni przed nim.';
    return;
  }
  const proba = { id: edytowaneId ?? -1, ...w, wykonane: false };
  if (czyPowtorka(proba)) {
    el.innerHTML = 'To powtórka przed egzaminem – nie dostaje osobnych sesji pracy.';
    return;
  }
  const plan = planSesji(proba);
  const potrzebne = SESJE_NA_PRIORYTET[w.priorytet];
  const p = pilnosc(proba);
  if (!plan.length) {
    el.innerHTML = `Pilność: <b>${NAZWA_PILNOSCI[p]}</b>. Wszystkie sesje pracy (${potrzebne}) już zrobione.`;
    return;
  }
  const dni = plan.map(s => s.data === DZIS ? 'dziś' : ladnaData(s.data)).join(' · ');
  el.innerHTML = `Pilność: <b>${NAZWA_PILNOSCI[p]}</b> · Ważność: <b>${NAZWA_PRIORYTETU[w.priorytet]}</b> → ${potrzebne} ${potrzebne === 1 ? 'sesja' : 'sesje'} pracy.<br>Plan: ${dni}.`;
}

function otworzFormularz(id = null, domyslnyTermin = null) {
  edytowaneId = id;
  const z = id !== null ? znajdz(id) : null;
  document.getElementById('okno-tytul').textContent = z ? 'Edytuj zadanie' : 'Nowe zadanie';
  formularz.reset();
  formularz.tytul.value = z ? z.tytul : '';
  formularz.opis.value = z ? z.opis : '';
  formularz.termin.value = z && z.termin ? z.termin : (domyslnyTermin || '');
  formularz.tagi.value = z ? z.tagi.join(', ') : '';
  const pri = z ? z.priorytet : 'sredni';
  formularz.querySelector(`input[name="priorytet"][value="${pri}"]`).checked = true;
  document.getElementById('blad-tytul').textContent = '';

  const wszystkieTagi = [...new Set(dane.zadania.flatMap(x => x.tagi))];
  document.getElementById('lista-tagow').innerHTML = wszystkieTagi.map(t => `<option value="${esc(t)}">`).join('');

  podgladPlanu();
  okno.showModal();
  formularz.tytul.focus();
}

formularz.addEventListener('input', podgladPlanu);
formularz.addEventListener('submit', e => {
  e.preventDefault();
  const w = zbierzFormularz();
  if (!w.tytul) {
    document.getElementById('blad-tytul').textContent = 'Podaj tytuł zadania.';
    formularz.tytul.focus();
    return;
  }
  if (w.termin && !poprawnaData(w.termin)) w.termin = null;

  if (edytowaneId !== null) {
    const z = znajdz(edytowaneId);
    Object.assign(z, w);
    powiadom(`Zapisano zmiany w „${z.tytul}”.`);
  } else {
    dane.zadania.push(uporzadkuj({ id: noweId(), ...w, wykonane: false }));
    powiadom(`Dodano „${w.tytul}”.`);
  }
  zapiszLokalnie();
  okno.close();
  odswiez();
});

/* =====================================================================
   Powiadomienia (z przyciskiem "Cofnij")
   ===================================================================== */
function powiadom(tekst, przycisk = null, akcja = null) {
  const pojemnik = document.getElementById('powiadomienia');
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${esc(tekst)}</span>`;
  if (przycisk && akcja) {
    const b = document.createElement('button');
    b.textContent = przycisk;
    b.onclick = () => { t.remove(); akcja(); };
    t.appendChild(b);
  }
  pojemnik.appendChild(t);
  while (pojemnik.children.length > 3) pojemnik.firstChild.remove();
  setTimeout(() => t.remove(), przycisk ? 6000 : 3500);
}

/* =====================================================================
   Obsługa kliknięć, filtrów, pliku
   ===================================================================== */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-akcja], [data-widok]');
  if (!el) return;
  if (el.dataset.widok) {
    widok = el.dataset.widok;
    odswiez();
    window.scrollTo(0, 0);
    return;
  }
  const id = el.dataset.id !== undefined ? Number(el.dataset.id) : null;
  switch (el.dataset.akcja) {
    case 'nowe': otworzFormularz(null, el.dataset.data || null); break;
    case 'edytuj': if (oknoSzczegoly.open) oknoSzczegoly.close(); otworzFormularz(id); break;
    case 'usun': if (oknoSzczegoly.open) oknoSzczegoly.close(); usun(id); break;
    case 'szczegoly': pokazSzczegoly(id); break;
    case 'zamknij-szczegoly': oknoSzczegoly.close(); break;
    case 'grupuj': filtry.grupuj = el.dataset.wartosc; odswiez(); break;
    case 'pokaz-zrobione': filtry.pokazZrobione = el.checked; odswiez(); break;
    case 'zaplanuj-powtorki': zaplanujPowtorki(id); break;
    case 'zakres': terminarz.zakres = el.dataset.wartosc; terminarz.przesuniecie = 0; odswiez(); break;
    case 'przesun': terminarz.przesuniecie = el.dataset.wartosc === '0' ? 0 : terminarz.przesuniecie + Number(el.dataset.wartosc); odswiez(); break;
    case 'pokaz-sesje': terminarz.pokazSesje = el.checked; odswiez(); break;
    case 'usun-egzamin': usunEgzamin(id); break;
    case 'odhacz': przelaczWykonane(id); break;
    case 'sesja': przelaczSesje(id, el.dataset.data); break;
    case 'wczytaj': document.getElementById('plik').click(); break;
    case 'zapisz': zapiszDoPliku(); break;
    case 'anuluj': okno.close(); break;
  }
});

tresc.addEventListener('input', e => {
  const k = e.target.dataset.filtr;
  if (!k) return;
  filtry[k] = e.target.value;
  odswiez();
});

document.getElementById('plik').addEventListener('change', e => {
  const plik = e.target.files[0];
  if (plik) wczytajZPliku(plik);
  e.target.value = '';
});

// Przeciągnij i upuść plik JSON na okno
const upuszczanie = document.getElementById('upuszczanie');
let licznikDrag = 0;
window.addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  licznikDrag++;
  upuszczanie.hidden = false;
});
window.addEventListener('dragleave', () => {
  licznikDrag = Math.max(0, licznikDrag - 1);
  if (!licznikDrag) upuszczanie.hidden = true;
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  licznikDrag = 0;
  upuszczanie.hidden = true;
  const plik = e.dataTransfer?.files?.[0];
  if (plik) wczytajZPliku(plik);
});

// Skrót klawiszowy: "n" = nowe zadanie
document.addEventListener('keydown', e => {
  if (e.key === 'n' && !okno.open && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    otworzFormularz();
  }
});

/* =====================================================================
   Start
   ===================================================================== */
if (!wczytajLokalnie() && window.PRZYKLADOWE_DANE) {
  dane = normalizuj(window.PRZYKLADOWE_DANE).dane;
  zapiszLokalnie();
}
odswiez();
