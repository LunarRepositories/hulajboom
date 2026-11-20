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
let widok = 'tydzien';   // widok startowy: kalendarz na 7 dni
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
        mapa[dzien].punkty += PUNKTY_ZA_TERMIN[z.priorytet];
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

function htmlZadania(z) {
  const p = pilnosc(z);
  const tagi = z.tagi.map(t => `<span class="znaczek tag">#${esc(t)}</span>`).join('');
  const terminKlasa = z.wykonane ? '' : p;
  return `
    <li class="zadanie p-${z.priorytet} ${z.wykonane ? 'zrobione' : ''}">
      <button class="odhacz" data-akcja="odhacz" data-id="${z.id}"
        title="${z.wykonane ? 'Cofnij wykonanie' : 'Oznacz jako zrobione'}"
        aria-label="${z.wykonane ? 'Cofnij wykonanie' : 'Oznacz jako zrobione'}">${z.wykonane ? '✓' : ''}</button>
      <div>
        <div class="zadanie-tytul">${esc(z.tytul)}</div>
        ${z.opis ? `<div class="zadanie-opis">${esc(z.opis)}</div>` : ''}
        <div class="meta">
          <span class="znaczek ${terminKlasa}">${esc(opisTerminu(z.termin))}</span>
          <span class="znaczek w-${z.priorytet}">Ważność: ${NAZWA_PRIORYTETU[z.priorytet]}</span>
          ${!z.wykonane ? `<span class="znaczek ${p}">Pilność: ${NAZWA_PILNOSCI[p]}</span>` : ''}
          ${tagi}
        </div>
      </div>
      <div class="zadanie-akcje">
        <button class="ikona" data-akcja="edytuj" data-id="${z.id}" title="Edytuj" aria-label="Edytuj">✎</button>
        <button class="ikona usun" data-akcja="usun" data-id="${z.id}" title="Usuń" aria-label="Usuń">🗑</button>
      </div>
    </li>`;
}

function htmlSesji(s) {
  const zrobiona = sesjaOdhaczona(s.zadanie.id, s.data);
  return `
    <li class="sesja ${zrobiona ? 'zrobiona' : ''}">
      <button class="odhacz" data-akcja="sesja" data-id="${s.zadanie.id}" data-data="${s.data}"
        aria-label="Odhacz sesję">${zrobiona ? '✓' : ''}</button>
      <div class="sesja-tekst">
        <strong>Sesja ${s.nr}/${s.z}:</strong> ${esc(s.zadanie.tytul)}
        <div class="maly-tekst">Termin: ${esc(opisTerminu(s.zadanie.termin))}</div>
      </div>
    </li>`;
}

function sekcja(tytul, licznik, wnetrze) {
  return `<section class="sekcja"><h2>${tytul} <span class="licznik">${licznik}</span></h2>${wnetrze}</section>`;
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
      ${widok !== 'plan' ? '<button class="przycisk maly" data-widok="plan">Zobacz plan</button>' : ''}
    </div>`;
}

function htmlLicznikaDnia(info) {
  const proc = Math.min(100, Math.round(info.punkty / LIMIT_DNIA * 100));
  const klasa = info.punkty > LIMIT_DNIA ? 'pelny' : info.punkty >= LIMIT_DNIA - 1 ? 'sredni' : '';
  const ocena = info.punkty > LIMIT_DNIA ? 'Za dużo na jeden dzień' : info.punkty >= LIMIT_DNIA - 1 ? 'Pełny dzień' : info.punkty === 0 ? 'Wolne – możesz zrobić coś na zapas' : 'Da się ogarnąć';
  return `
    <div class="obciazenie">
      <div class="obciazenie-gora">
        <strong>Obciążenie dnia: ${info.punkty} / ${LIMIT_DNIA} pkt</strong>
        <span class="maly-tekst">${ocena}</span>
      </div>
      <div class="pasek ${klasa}"><div style="width:${proc}%"></div></div>
      <div class="maly-tekst" style="margin-top:6px">Termin: wysoki 3 pkt, średni 2, niski 1 · sesja pracy 1 pkt</div>
    </div>`;
}

function widokDzis(mapa) {
  const zalegle = dane.zadania.filter(poTerminie).sort(porownajTermin);
  const naDzis = dane.zadania.filter(z => !z.wykonane && z.termin === DZIS).sort(porownajWaznosc);
  const sesjeDzis = mapa[DZIS].sesje;
  // sesje odhaczone dziś (już nie ma ich w planie, ale chcemy je widzieć jako zrobione)
  const odhaczoneDzis = dane.zadania
    .filter(z => sesjaOdhaczona(z.id, DZIS))
    .map(z => ({ data: DZIS, zadanie: z, nr: zrobioneSesje(z.id).indexOf(DZIS) + 1, z: SESJE_NA_PRIORYTET[z.priorytet] }));
  const zrobioneDzisZadania = dane.zadania.filter(z => z.wykonane && z.termin === DZIS);

  let html = htmlLicznikaDnia(mapa[DZIS]);
  if (zalegle.length) html += sekcja('Po terminie', zalegle.length, `<ul class="lista">${zalegle.map(htmlZadania).join('')}</ul>`);
  html += sekcja('Termin dziś', naDzis.length,
    naDzis.length ? `<ul class="lista">${naDzis.map(htmlZadania).join('')}</ul>` : '<div class="pusto">Na dziś nie ma żadnych terminów.</div>');
  const wszystkieSesje = [...sesjeDzis, ...odhaczoneDzis];
  html += sekcja('Sesje pracy na dziś', wszystkieSesje.length,
    wszystkieSesje.length
      ? `<ul class="lista">${wszystkieSesje.map(htmlSesji).join('')}</ul>`
      : '<div class="pusto">Dziś nie ma zaplanowanych sesji pracy.</div>');
  if (zrobioneDzisZadania.length) html += sekcja('Zrobione dziś', zrobioneDzisZadania.length, `<ul class="lista">${zrobioneDzisZadania.map(htmlZadania).join('')}</ul>`);
  return html;
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
  if (z.wykonane) planHtml = 'Zadanie zrobione.';
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

/* ---------- Kalendarz na najbliższe 7 dni (widok startowy) ---------- */
function htmlKarty(z) {
  const zalegle = z.termin < DZIS;
  return `
    <li class="karta p-${z.priorytet}">
      <button class="odhacz maly-odhacz" data-akcja="odhacz" data-id="${z.id}"
        title="Oznacz jako zrobione" aria-label="Oznacz jako zrobione"></button>
      <button class="karta-tresc" data-akcja="edytuj" data-id="${z.id}" title="Kliknij, aby edytować">
        <span class="karta-tytul">${esc(z.tytul)}</span>
        ${zalegle ? `<span class="znaczek pilne">zaległe · ${esc(ladnaData(z.termin, false))}</span>` : ''}
        ${z.tagi.length ? `<span class="karta-tagi">${z.tagi.map(t => '#' + esc(t)).join(' ')}</span>` : ''}
      </button>
    </li>`;
}

function widokTydzien(mapa) {
  const kolumny = [];
  for (let i = 0; i < 7; i++) {
    const d = dodajDni(DZIS, i);
    // zadania do zrobienia z terminem tego dnia; zaległe pokazujemy w kolumnie "dziś"
    const zadania = dane.zadania
      .filter(z => !z.wykonane && z.termin && (z.termin === d || (i === 0 && z.termin < DZIS)))
      .sort(porownajTermin)
      .sort((a, b) => WAGA_PRIORYTETU[b.priorytet] - WAGA_PRIORYTETU[a.priorytet]);
    const data = zISO(d);
    kolumny.push(`
      <div class="kolumna ${i === 0 ? 'dzisiaj' : ''}">
        <div class="kolumna-gora">
          <span class="kolumna-dzien">${i === 0 ? 'Dziś' : esc(data.toLocaleDateString('pl-PL', { weekday: 'long' }))}</span>
          <span class="kolumna-data">${esc(data.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }))}</span>
        </div>
        ${zadania.length ? `<ul class="karty">${zadania.map(htmlKarty).join('')}</ul>` : '<div class="kolumna-pusta">Brak terminów</div>'}
        <button class="dodaj-w-dniu" data-akcja="nowe" data-data="${d}" title="Dodaj zadanie na ten dzień">+ Dodaj</button>
      </div>`);
  }
  const bezTerminu = dane.zadania.filter(z => !z.wykonane && !z.termin).length;
  const pozniej = dane.zadania.filter(z => !z.wykonane && z.termin && z.termin > dodajDni(DZIS, 6)).length;

  let html = '';
  html += `<div class="tydzien">${kolumny.join('')}</div>`;
  html += `<p class="maly-tekst tydzien-stopka">Kolor paska = ważność zadania. Kliknij zadanie, aby je edytować, a kółko – aby je odhaczyć.
    ${pozniej ? `Później: ${pozniej} zad.` : ''} ${bezTerminu ? `· Bez terminu: ${bezTerminu} zad.` : ''}
    <button class="link" data-widok="wszystkie">Zobacz wszystkie →</button></p>`;
  return html;
}

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

function widokPlan(mapa) {
  const bezTerminu = dane.zadania.filter(z => !z.wykonane && !z.termin);
  const dni = Object.entries(mapa).map(([d, info]) => {
    const przeciazony = info.punkty > LIMIT_DNIA;
    const proc = Math.min(100, Math.round(info.punkty / LIMIT_DNIA * 100));
    const klasa = przeciazony ? 'pelny' : info.punkty >= LIMIT_DNIA - 1 ? 'sredni' : '';
    const pozycje = [
      ...info.terminy.map(z => `<li><span class="kropka ${z.priorytet}"></span><span><b>Termin:</b> ${esc(z.tytul)}${z.termin < DZIS ? ' <span class="znaczek pilne">zaległe</span>' : ''}</span></li>`),
      ...info.sesje.map(s => `<li><span class="kropka sesja-kropka"></span><span>Sesja ${s.nr}/${s.z}: ${esc(s.zadanie.tytul)}</span></li>`),
    ];
    return `
      <div class="dzien ${przeciazony ? 'przeciazony' : ''} ${d === DZIS ? 'dzisiaj' : ''}">
        <div class="dzien-gora">
          <span class="dzien-nazwa">${d === DZIS ? 'Dziś · ' : ''}${ladnaData(d)}</span>
          <span class="maly-tekst">${przeciazony ? '⚠ ' : ''}${info.punkty} / ${LIMIT_DNIA} pkt</span>
        </div>
        <div class="pasek ${klasa}"><div style="width:${proc}%"></div></div>
        ${pozycje.length ? `<ul>${pozycje.join('')}</ul>` : '<div class="pusty-dzien">Wolne</div>'}
      </div>`;
  }).join('');

  let html = '';
  html += `<p class="maly-tekst" style="margin-top:0">Plan liczy się sam: ważność (priorytet) decyduje, ile sesji pracy potrzebuje zadanie,
    a pilność (czas do terminu) – jak gęsto są rozłożone. Pominięta sesja nie przepada, tylko przesuwa się na kolejne dni.</p>`;
  html += `<div class="dni">${dni}</div>`;
  if (bezTerminu.length) {
    html += `<section class="sekcja" style="margin-top:24px"><h2>Bez terminu <span class="licznik">${bezTerminu.length}</span></h2>
      <p class="maly-tekst" style="margin-top:0">Tych zadań nie da się zaplanować – zrób je, gdy dzień jest luźny.</p>
      <ul class="lista">${bezTerminu.sort(porownajWaznosc).map(htmlZadania).join('')}</ul></section>`;
  }
  return html;
}

function odswiez() {
  const mapa = obciazenieDni();
  const fokus = document.activeElement?.dataset?.filtr;   // nie gubimy kursora w wyszukiwarce

  if (oknoSzczegoly.open && szczegolyId !== null) pokazSzczegoly(szczegolyId);

  if (widok === 'tydzien') tresc.innerHTML = widokTydzien(mapa);
  else if (widok === 'alarmy') tresc.innerHTML = widokAlarmy(mapa);
  else if (widok === 'dzis') tresc.innerHTML = widokDzis(mapa);
  else if (widok === 'plan') tresc.innerHTML = widokPlan(mapa);
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
