const STORAGE_KEY = 'precinct-mapper:files:v1';
const GEOCODE_KEY = 'precinct-mapper:geocode-cache:v1';
const ADDRESS_COLUMNS = ['address', 'street_address', 'street address', 'location', 'full_address', 'full address'];
const LAT_COLUMNS = ['lat', 'latitude', 'y'];
const LON_COLUMNS = ['lon', 'lng', 'long', 'longitude', 'x'];

const state = {
  files: readJson(STORAGE_KEY, []),
  geocodeCache: readJson(GEOCODE_KEY, {}),
  geometries: [],
  settings: { baselineMode: 'previous', direction: 'lowerIsBehind', metrics: [] },
};

const el = {
  uploadYear: document.querySelector('#uploadYear'), csvInput: document.querySelector('#csvInput'), buildMap: document.querySelector('#buildMap'), clearData: document.querySelector('#clearData'),
  geocodeProgress: document.querySelector('#geocodeProgress'), comparisonYear: document.querySelector('#comparisonYear'), baselineMode: document.querySelector('#baselineMode'), baselineYear: document.querySelector('#baselineYear'),
  baselineYearWrap: document.querySelector('#baselineYearWrap'), direction: document.querySelector('#direction'), metrics: document.querySelector('#metrics'), addMetric: document.querySelector('#addMetric'),
  messages: document.querySelector('#messages'), mapSvg: document.querySelector('#mapSvg'), resultsBody: document.querySelector('#resultsBody'), fileInventory: document.querySelector('#fileInventory'), fileCount: document.querySelector('#fileCount'), behindCount: document.querySelector('#behindCount'),
};

el.uploadYear.value = new Date().getFullYear();
el.csvInput.addEventListener('change', () => uploadFiles(el.csvInput.files));
el.buildMap.addEventListener('click', buildMapGeometry);
el.clearData.addEventListener('click', clearUploadedData);
el.addMetric.addEventListener('click', () => { const columns = numericColumns(); if (columns.length) state.settings.metrics.push({ column: columns[0], weight: 1 }); render(); });
for (const control of [el.comparisonYear, el.baselineMode, el.baselineYear, el.direction]) control.addEventListener('change', updateSettingsFromControls);

hydrateInitialGeometry();
render();

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const year = Number(el.uploadYear.value);
  const notices = [];
  try {
    for (const file of files) {
      const text = await file.text();
      const parsed = parseCsv(text);
      const record = csvRecord(file.name, year, parsed);
      state.files.push(record);
      notices.push(`Uploaded ${file.name} with ${record.rows.length} rows for ${year}.`);
    }
    persistFiles();
    showMessages(notices);
    hydrateInitialGeometry();
    render();
  } catch (error) {
    showMessages([error.message || 'Unable to upload CSV files.']);
  } finally {
    el.csvInput.value = '';
  }
}

function csvRecord(fileName, year, parsed) {
  const columns = parsed.headers;
  const precinctColumn = findColumn(columns, ['precinct']);
  const addressColumn = findColumn(columns, ADDRESS_COLUMNS);
  const latColumn = findColumn(columns, LAT_COLUMNS);
  const lonColumn = findColumn(columns, LON_COLUMNS);
  if (!precinctColumn) throw new Error(`${fileName} is missing the required "precinct" column.`);
  if (!addressColumn && !(latColumn && lonColumn)) throw new Error(`${fileName} needs an address column or latitude/longitude columns.`);
  const fileId = crypto.randomUUID();
  const rows = parsed.rows.map((row, index) => ({
    id: `${fileId}:${index}`, sourceFileId: fileId, sourceFileName: fileName, year,
    precinct: String(row[precinctColumn] || '').trim(), address: addressColumn ? String(row[addressColumn] || '').trim() : '',
    latitude: latColumn ? toNumber(row[latColumn]) : null, longitude: lonColumn ? toNumber(row[lonColumn]) : null,
    values: Object.fromEntries(columns.map((column) => [column, coerceCell(row[column])])),
  })).filter((row) => row.precinct);
  if (!rows.length) throw new Error(`${fileName} did not contain rows with precinct values.`);
  return { id: fileId, fileName, year, uploadedAt: new Date().toISOString(), rowCount: rows.length, columns, rows };
}

async function buildMapGeometry() {
  const rows = allRows();
  const points = [];
  const failures = [];
  const geocodeRows = rows.filter((row) => !hasCoordinate(row));
  let complete = 0;
  el.buildMap.disabled = true;
  try {
    for (const row of rows) {
      if (hasCoordinate(row)) { points.push(pointFromRow(row, row.latitude, row.longitude)); continue; }
      const key = normalizeAddress(row.address);
      if (!key) { failures.push(`Missing address in precinct ${row.precinct}.`); continue; }
      if (!state.geocodeCache[key]) {
        el.geocodeProgress.textContent = `Geocoding ${row.address} (${complete}/${geocodeRows.length})`;
        state.geocodeCache[key] = await geocode(row.address);
        writeJson(GEOCODE_KEY, state.geocodeCache);
        await delay(1100);
      }
      const cached = state.geocodeCache[key];
      points.push(pointFromRow(row, cached.lat, cached.lon));
      complete += 1;
      el.geocodeProgress.textContent = `Geocoded ${complete} of ${geocodeRows.length} uncached address rows.`;
    }
    state.geometries = createGeometries(points);
    showMessages([`Created map geometry for ${state.geometries.length} precinct(s) from ${points.length} address point(s).`, ...failures.slice(0, 8)]);
  } catch (error) {
    showMessages([error.message || 'Unable to build map geometry.']);
  } finally {
    el.buildMap.disabled = false;
    render();
  }
}

function render() {
  const years = [...new Set(state.files.map((file) => file.year))].sort((a, b) => a - b);
  const columns = numericColumns();
  if (!state.settings.comparisonYear && years.length) state.settings.comparisonYear = years.at(-1);
  if (!state.settings.baselineYear && years.length > 1) state.settings.baselineYear = years.at(-2);
  if (!state.settings.metrics.length && columns.length) state.settings.metrics = [{ column: columns[0], weight: 1 }];

  fillSelect(el.comparisonYear, years, state.settings.comparisonYear);
  fillSelect(el.baselineYear, years, state.settings.baselineYear);
  el.baselineMode.value = state.settings.baselineMode;
  el.direction.value = state.settings.direction;
  el.baselineYearWrap.classList.toggle('hidden', state.settings.baselineMode !== 'specific');
  renderMetricControls(columns);

  const comparisons = comparePrecincts();
  el.fileCount.textContent = state.files.length;
  el.behindCount.textContent = comparisons.filter((item) => item.behindScore > 0).length;
  renderMap(comparisons);
  renderResults(comparisons);
  renderFileInventory();
}

function renderMetricControls(columns) {
  el.metrics.innerHTML = '';
  state.settings.metrics.forEach((metric, index) => {
    const row = document.createElement('div'); row.className = 'metric-row';
    const select = document.createElement('select'); fillSelect(select, columns, metric.column);
    select.addEventListener('change', () => { state.settings.metrics[index].column = select.value; render(); });
    const weight = document.createElement('input'); weight.type = 'number'; weight.min = '0'; weight.step = '0.1'; weight.value = metric.weight;
    weight.addEventListener('change', () => { state.settings.metrics[index].weight = Number(weight.value); render(); });
    const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => { state.settings.metrics.splice(index, 1); render(); });
    row.append(select, weight, remove); el.metrics.append(row);
  });
}

function comparePrecincts() {
  const rows = allRows();
  if (!state.settings.comparisonYear || !state.settings.metrics.length) return [];
  return [...new Set(rows.map((row) => row.precinct))].sort().map((precinct) => {
    const breakdown = state.settings.metrics.map((metric) => metricResult(rows, precinct, metric));
    const totalWeight = state.settings.metrics.reduce((sum, metric) => sum + Math.max(metric.weight, 0), 0) || 1;
    return {
      precinct, comparisonYear: state.settings.comparisonYear, baselineLabel: baselineLabel(rows),
      comparisonValue: weightedAverage(breakdown.map((item) => [item.comparisonValue, item.weight])),
      baselineValue: weightedAverage(breakdown.map((item) => [item.baselineValue, item.weight])),
      absoluteDifference: weightedAverage(breakdown.map((item) => [item.absoluteDifference, item.weight])),
      percentDifference: weightedAverage(breakdown.map((item) => [item.percentDifference, item.weight])),
      behindScore: breakdown.reduce((sum, item) => sum + item.behindScore, 0) / totalWeight,
      breakdown,
    };
  }).sort((a, b) => b.behindScore - a.behindScore);
}

function metricResult(rows, precinct, metric) {
  const comparisonValue = aggregate(rows, precinct, state.settings.comparisonYear, metric.column);
  const baselineValue = baselineValueFor(rows, precinct, metric.column);
  const absoluteDifference = comparisonValue == null || baselineValue == null ? null : comparisonValue - baselineValue;
  const percentDifference = absoluteDifference == null || baselineValue === 0 ? null : (absoluteDifference / Math.abs(baselineValue)) * 100;
  const rawBehind = absoluteDifference == null ? 0 : (state.settings.direction === 'lowerIsBehind' ? -absoluteDifference : absoluteDifference);
  const behindScore = Math.max(0, percentDifference == null ? rawBehind : Math.max(rawBehind, Math.abs(percentDifference))) * Math.max(metric.weight, 0);
  return { ...metric, comparisonValue, baselineValue, absoluteDifference, percentDifference, behindScore };
}

function baselineValueFor(rows, precinct, column) {
  const comparisonYear = state.settings.comparisonYear;
  if (state.settings.baselineMode === 'specific') return aggregate(rows, precinct, state.settings.baselineYear, column);
  const priorYears = [...new Set(rows.filter((row) => row.precinct === precinct && row.year < comparisonYear).map((row) => row.year))].sort((a, b) => a - b);
  if (state.settings.baselineMode === 'previous') return priorYears.length ? aggregate(rows, precinct, priorYears.at(-1), column) : null;
  const values = priorYears.map((year) => aggregate(rows, precinct, year, column)).filter((value) => value != null);
  if (!values.length) return null;
  if (state.settings.baselineMode === 'best') return state.settings.direction === 'lowerIsBehind' ? Math.max(...values) : Math.min(...values);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderMap(comparisons) {
  const comparisonMap = new Map(comparisons.map((item) => [item.precinct, item]));
  const maxScore = Math.max(1, ...comparisons.map((item) => item.behindScore));
  const bounds = geometryBounds(state.geometries);
  el.mapSvg.innerHTML = '';
  if (!state.geometries.length) { el.mapSvg.innerHTML = '<text x="50%" y="50%" text-anchor="middle">Upload CSVs, then build map geometry.</text>'; return; }
  for (const geometry of state.geometries) {
    const comparison = comparisonMap.get(geometry.precinct);
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', geometry.polygon.map(([lat, lon]) => project(lat, lon, bounds)).join(' '));
    polygon.setAttribute('fill', heatColor(comparison?.behindScore || 0, maxScore)); polygon.setAttribute('stroke', '#0f172a'); polygon.setAttribute('stroke-width', '1'); polygon.setAttribute('opacity', '0.82');
    polygon.innerHTML = `<title>${escapeHtml(geometry.precinct)} — behind score ${formatNumber(comparison?.behindScore)}</title>`;
    el.mapSvg.append(polygon);
  }
}

function renderResults(comparisons) {
  el.resultsBody.innerHTML = comparisons.map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.precinct)}</td><td>${formatNumber(item.comparisonValue)}</td><td>${escapeHtml(item.baselineLabel)}: ${formatNumber(item.baselineValue)}</td><td>${formatNumber(item.absoluteDifference)}</td><td>${formatPercent(item.percentDifference)}</td><td>${formatNumber(item.behindScore)}</td></tr>`).join('') || '<tr><td colspan="7">No comparison results yet.</td></tr>';
}

function parseCsv(text) {
  const rows = []; let current = ['']; let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]; const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') { current[current.length - 1] += '"'; i += 1; }
    else if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) current.push('');
    else if ((char === '\n' || char === '\r') && !inQuotes) { if (char === '\r' && next === '\n') i += 1; rows.push(current); current = ['']; }
    else current[current.length - 1] += char;
  }
  if (current.some((cell) => cell.trim())) rows.push(current);
  const headers = rows.shift()?.map((header) => header.trim()) || [];
  return { headers, rows: rows.filter((row) => row.some((cell) => cell.trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || '']))) };
}

function createGeometries(points) {
  const groups = new Map();
  for (const point of points) groups.set(point.precinct, [...(groups.get(point.precinct) || []), point]);
  return [...groups.entries()].map(([precinct, group]) => {
    const unique = dedupe(group.map((point) => [point.lat, point.lon]));
    const centroid = getCentroid(unique);
    return { precinct, pointCount: group.length, centroid, polygon: unique.length >= 3 ? convexHull(unique) : bufferAround(centroid, unique.length === 1 ? 0.004 : 0.0025) };
  });
}
function convexHull(points) { const sorted = [...points].sort((a, b) => a[1] - b[1] || a[0] - b[0]); const half = (list) => { const out = []; for (const point of list) { while (out.length >= 2 && cross(out.at(-2), out.at(-1), point) <= 0) out.pop(); out.push(point); } return out; }; return half(sorted).slice(0, -1).concat(half([...sorted].reverse()).slice(0, -1)); }
function cross(o, a, b) { return (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]); }
function bufferAround([lat, lon], radius) { return Array.from({ length: 18 }, (_, i) => [lat + Math.sin((Math.PI * 2 * i) / 18) * radius, lon + Math.cos((Math.PI * 2 * i) / 18) * radius]); }
function getCentroid(points) { return points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]); }
function geometryBounds(geometries) { const points = geometries.flatMap((geo) => geo.polygon); const lats = points.map((p) => p[0]); const lons = points.map((p) => p[1]); return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) }; }
function project(lat, lon, bounds) { const pad = 40; const width = el.mapSvg.clientWidth || 1000; const height = el.mapSvg.clientHeight || 560; const x = pad + ((lon - bounds.minLon) / Math.max(bounds.maxLon - bounds.minLon, 0.001)) * (width - pad * 2); const y = pad + ((bounds.maxLat - lat) / Math.max(bounds.maxLat - bounds.minLat, 0.001)) * (height - pad * 2); return `${x.toFixed(1)},${y.toFixed(1)}`; }
async function geocode(address) { const params = new URLSearchParams({ q: address, format: 'jsonv2', limit: '1' }); const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`); if (!response.ok) throw new Error(`Geocoder returned ${response.status}`); const [first] = await response.json(); if (!first) throw new Error(`No geocoder result for ${address}.`); return { address, lat: Number(first.lat), lon: Number(first.lon), displayName: first.display_name, updatedAt: new Date().toISOString() }; }
function hydrateInitialGeometry() { state.geometries = createGeometries(allRows().filter(hasCoordinate).map((row) => pointFromRow(row, row.latitude, row.longitude))); }
function numericColumns() { const counts = new Map(); for (const row of allRows()) for (const [column, value] of Object.entries(row.values)) if (column.toLowerCase() !== 'precinct' && typeof value === 'number') counts.set(column, (counts.get(column) || 0) + 1); return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([column]) => column); }
function renderFileInventory() { el.fileInventory.innerHTML = state.files.map((file) => `<article><strong>${escapeHtml(file.fileName)}</strong><span>${file.year}</span><span>${file.rowCount} rows</span><small>${new Date(file.uploadedAt).toLocaleString()}</small></article>`).join('') || '<p class="muted">No uploads yet.</p>'; }
function updateSettingsFromControls() { state.settings.comparisonYear = Number(el.comparisonYear.value) || null; state.settings.baselineMode = el.baselineMode.value; state.settings.baselineYear = Number(el.baselineYear.value) || null; state.settings.direction = el.direction.value; render(); }
function fillSelect(select, values, selected) { select.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join(''); if (selected != null) select.value = selected; }
function aggregate(rows, precinct, year, column) { const values = rows.filter((row) => row.precinct === precinct && row.year === year).map((row) => row.values[column]).filter((value) => typeof value === 'number'); return values.length ? values.reduce((sum, value) => sum + value, 0) : null; }
function baselineLabel(rows) { if (state.settings.baselineMode === 'specific') return String(state.settings.baselineYear || 'selected year'); if (state.settings.baselineMode === 'previous') { const years = [...new Set(rows.map((row) => row.year))].filter((year) => year < state.settings.comparisonYear).sort((a, b) => a - b); return years.length ? `Previous year (${years.at(-1)})` : 'Previous year'; } return state.settings.baselineMode === 'best' ? 'Best prior year' : 'Average of prior years'; }
function weightedAverage(values) { const valid = values.filter(([value, weight]) => value != null && Number.isFinite(value) && weight > 0); const total = valid.reduce((sum, [, weight]) => sum + weight, 0); return total ? valid.reduce((sum, [value, weight]) => sum + value * weight, 0) / total : null; }
function heatColor(score, maxScore) { if (score <= 0) return '#2563eb'; const ratio = Math.min(score / maxScore, 1); return ratio > 0.8 ? '#7f1d1d' : ratio > 0.6 ? '#b91c1c' : ratio > 0.4 ? '#ef4444' : ratio > 0.2 ? '#f97316' : '#fbbf24'; }
function allRows() { return state.files.flatMap((file) => file.rows); }
function hasCoordinate(row) { return Number.isFinite(row.latitude) && Number.isFinite(row.longitude); }
function pointFromRow(row, lat, lon) { return { rowId: row.id, precinct: row.precinct, address: row.address, lat, lon }; }
function findColumn(columns, candidates) { const map = new Map(columns.map((column) => [column.trim().toLowerCase(), column])); return candidates.map((candidate) => map.get(candidate)).find(Boolean); }
function coerceCell(value) { const text = String(value || '').trim(); if (!text) return null; const number = toNumber(text.replace(/[$,%]/g, '')); return number ?? text; }
function toNumber(value) { const number = Number(String(value || '').trim()); return Number.isFinite(number) ? number : null; }
function normalizeAddress(address) { return String(address || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function dedupe(points) { return [...new Map(points.map((point) => [`${point[0].toFixed(7)},${point[1].toFixed(7)}`, point])).values()]; }
function persistFiles() { writeJson(STORAGE_KEY, state.files); }
function clearUploadedData() { state.files = []; state.geometries = []; state.settings.metrics = []; persistFiles(); showMessages(['Cleared uploaded files. Geocode cache is retained for future uploads.']); render(); }
function showMessages(messages) { el.messages.classList.toggle('hidden', messages.length === 0); el.messages.innerHTML = messages.map((message) => `<p>${escapeHtml(message)}</p>`).join(''); }
function readJson(key, fallback) { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
function writeJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function formatNumber(value) { return value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value); }
function formatPercent(value) { return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
