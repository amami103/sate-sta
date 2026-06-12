#!/usr/bin/env node
/*
  道の駅一覧（michinoeki_list.json）に緯度経度を付与して、stations.js 形式で出力するスクリプト。

  使い方（Node.js 18+）:
    node enrich_michinoeki_latlng.js

  入力:
    ./michinoeki_list.json

  出力:
    ./michinoeki_stations_with_latlng.js
    ./michinoeki_latlng_missing.json

  座標取得元:
    IT-SOCIAL「道の駅データベースAPI」
    https://it-social.net/roadside_station/

  注意:
    APIの日本語キーは、環境や取得データにより「経度」「緯度」の表示が紛らわしい場合があります。
    このスクリプトでは数値範囲（日本の緯度=20〜50、経度=120〜155）で lat/lng を安全に判定します。
*/

const fs = require('fs/promises');
const path = require('path');

const INPUT = process.argv[2] || path.join(__dirname, 'michinoeki_list.json');
const OUTPUT = process.argv[3] || path.join(__dirname, 'michinoeki_stations_with_latlng.js');
const MISSING_OUTPUT = path.join(path.dirname(OUTPUT), 'michinoeki_latlng_missing.json');
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);
const EXTRA_SCAN = Number(process.env.EXTRA_SCAN || 60); // 廃止・欠番・最新追加分のズレ対策
const API_BASE = 'https://it-social.net/roadside_station/json/';

const PREF_CODES = {
  '北海道': '01',
  '青森県': '02',
  '岩手県': '03',
  '宮城県': '04',
  '秋田県': '05',
  '山形県': '06',
  '福島県': '07',
  '茨城県': '08',
  '栃木県': '09',
  '群馬県': '10',
  '埼玉県': '11',
  '千葉県': '12',
  '東京都': '13',
  '神奈川県': '14',
  '新潟県': '15',
  '富山県': '16',
  '石川県': '17',
  '福井県': '18',
  '山梨県': '19',
  '長野県': '20',
  '岐阜県': '21',
  '静岡県': '22',
  '愛知県': '23',
  '三重県': '24',
  '滋賀県': '25',
  '京都府': '26',
  '大阪府': '27',
  '兵庫県': '28',
  '奈良県': '29',
  '和歌山県': '30',
  '鳥取県': '31',
  '島根県': '32',
  '岡山県': '33',
  '広島県': '34',
  '山口県': '35',
  '徳島県': '36',
  '香川県': '37',
  '愛媛県': '38',
  '高知県': '39',
  '福岡県': '40',
  '佐賀県': '41',
  '長崎県': '42',
  '熊本県': '43',
  '大分県': '44',
  '宮崎県': '45',
  '鹿児島県': '46',
  '沖縄県': '47',
};

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/^道の駅/, '')
    .replace(/[\s\u3000\t\r\n]/g, '')
    .replace(/[・･]/g, '')
    .replace(/[!！?？]/g, '')
    .replace(/[「」『』【】\[\]（）()]/g, '')
    .replace(/[‐‑‒–—―-]/g, '')
    .replace(/\./g, '')
    .toLowerCase();
}

function normalizeUrl(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickLatLng(record) {
  const a = toNumber(record['経度']);
  const b = toNumber(record['緯度']);

  // 一部データ・表示では「経度」「緯度」のラベルが紛らわしいため、日本国内の数値範囲で判定する。
  if (a !== null && b !== null) {
    if (a >= 20 && a <= 50 && b >= 120 && b <= 155) return { lat: a, lng: b };
    if (b >= 20 && b <= 50 && a >= 120 && a <= 155) return { lat: b, lng: a };
  }
  return { lat: null, lng: null };
}

function partialParseJsonLike(text, id) {
  // JSONが壊れている/末尾にノイズがある場合でも、照合に必要な項目だけ拾う。
  const record = { ID: id };
  const stringKeys = [
    '名称', '通称', '都道府県', '市区町村', '住所',
    'Webサイト1', 'Webサイト2', 'Webサイト3', 'Webサイト4',
  ];
  for (const key of stringKeys) {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"`));
    if (m) record[key] = m[1].replace(/\\\//g, '/');
  }
  for (const key of ['経度', '緯度']) {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    if (m) record[key] = Number(m[1]);
  }
  return record['名称'] ? record : null;
}

async function fetchStation(id, retries = 2) {
  const url = `${API_BASE}${id}.json`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json,text/plain,*/*' } });
      if (!res.ok) return null;
      const text = (await res.text()).replace(/^\uFEFF/, '').trim();
      if (!text || text === 'null') return null;
      try {
        return JSON.parse(text);
      } catch {
        return partialParseJsonLike(text, id);
      }
    } catch (err) {
      if (attempt === retries) return null;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  return null;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function candidateNames(record) {
  const names = [];
  for (const key of ['名称', '通称']) {
    const value = record[key];
    if (!value) continue;
    names.push(value);
    String(value).split(/[|｜,，、/／]/).forEach((part) => names.push(part));
  }
  return uniq(names.map(normalizeName));
}

function candidateUrls(record) {
  const urls = [];
  for (const key of ['Webサイト1', 'Webサイト2', 'Webサイト3', 'Webサイト4']) {
    if (record[key]) urls.push(normalizeUrl(record[key]));
  }
  return uniq(urls);
}

function buildIndexes(apiRecords) {
  const byName = new Map();
  const byUrl = new Map();
  const byPref = new Map();

  for (const record of apiRecords) {
    const pref = record['都道府県'];
    if (!pref) continue;
    const coord = pickLatLng(record);
    if (coord.lat === null || coord.lng === null) continue;
    const enriched = { ...record, ...coord, _names: candidateNames(record), _urls: candidateUrls(record) };

    if (!byPref.has(pref)) byPref.set(pref, []);
    byPref.get(pref).push(enriched);

    for (const name of enriched._names) {
      if (!name) continue;
      const key = `${pref}::${name}`;
      if (!byName.has(key)) byName.set(key, enriched);
    }
    for (const url of enriched._urls) {
      if (!url) continue;
      byUrl.set(url, enriched);
    }
  }
  return { byName, byUrl, byPref };
}

function findMatch(station, indexes) {
  const pref = station.pref;
  const name = normalizeName(station.name);
  const url = normalizeUrl(station.url);

  if (url && indexes.byUrl.has(url)) return indexes.byUrl.get(url);

  const exact = indexes.byName.get(`${pref}::${name}`);
  if (exact) return exact;

  // 表記揺れ救済: 同じ都道府県内で「片方が片方を含む」場合だけ許す。
  const candidates = indexes.byPref.get(pref) || [];
  const fuzzy = candidates.find((record) => record._names.some((n) => {
    if (!n || !name) return false;
    if (n.length < 3 || name.length < 3) return false;
    return n.includes(name) || name.includes(n);
  }));
  return fuzzy || null;
}

async function main() {
  const stations = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const counts = stations.reduce((acc, station) => {
    acc[station.pref] = (acc[station.pref] || 0) + 1;
    return acc;
  }, {});

  const ids = [];
  for (const [pref, code] of Object.entries(PREF_CODES)) {
    const maxSeq = (counts[pref] || 0) + EXTRA_SCAN;
    for (let seq = 1; seq <= maxSeq; seq++) {
      ids.push(`${code}${String(seq).padStart(3, '0')}`);
    }
  }

  console.log(`Fetching coordinate records: ${ids.length} API candidates...`);
  let done = 0;
  const apiRecords = (await mapLimit(ids, CONCURRENCY, async (id) => {
    const record = await fetchStation(id);
    done += 1;
    if (done % 100 === 0 || done === ids.length) {
      process.stdout.write(`\r${done}/${ids.length}`);
    }
    return record;
  })).filter(Boolean);
  process.stdout.write('\n');
  console.log(`Fetched usable records: ${apiRecords.length}`);

  const indexes = buildIndexes(apiRecords);
  const missing = [];
  let matched = 0;

  const outputStations = stations.map((station) => {
    const match = findMatch(station, indexes);
    if (match) {
      matched += 1;
      return {
        ...station,
        lat: match.lat,
        lng: match.lng,
      };
    }
    missing.push(station);
    return station;
  });

  const header = `// Generated from list.pdf: R7.12 「道の駅」登録一覧\n// Latitude/longitude enriched from IT-SOCIAL Roadside Station API.\n// Unmatched entries keep lat/lng as null. See michinoeki_latlng_missing.json.\n`;
  await fs.writeFile(OUTPUT, `${header}const stations = ${JSON.stringify(outputStations, null, 2)};\n`, 'utf8');
  await fs.writeFile(MISSING_OUTPUT, JSON.stringify(missing, null, 2), 'utf8');

  console.log(`Matched: ${matched}/${stations.length}`);
  console.log(`Missing: ${missing.length}`);
  console.log(`Wrote: ${OUTPUT}`);
  console.log(`Wrote: ${MISSING_OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
