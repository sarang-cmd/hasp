import { sampleItems, filterItems } from './state.mjs';
import { normalizeAppearance } from './appearance.mjs';
const $ = selector => document.querySelector(selector);
const list = $('#items');
const detail = $('#detail');
const search = $('#search');
const environment = $('#environment');
let type = 'All';
let selected = sampleItems[0].id;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function mark(item) {
  const plate = element('span', 'mark');
  const img = document.createElement('img');
  img.src = `/brands/${item.brand}.svg`;
  img.alt = '';
  plate.append(img);
  return plate;
}
function render() {
  const visible = filterItems(sampleItems, { query: search.value, type, environment: environment.value });
  if (!visible.some(item => item.id === selected)) selected = visible[0]?.id || null;
  list.replaceChildren();
  visible.forEach(item => {
    const button = element('button', 'item' + (item.id === selected ? ' selected' : ''));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(item.id === selected));
    const identity = element('span', 'identity');
    const names = element('span', 'item-names');
    names.append(element('strong', '', item.name), element('small', '', item.domain));
    identity.append(mark(item), names);
    button.append(identity, element('span', 'badge ' + item.environment, item.environment), element('span', 'item-type', item.type));
    button.addEventListener('click', () => { selected = item.id; render(); list.querySelector('.selected')?.focus(); });
    list.append(button);
  });
  $('#empty').hidden = visible.length > 0;
  $('#results').textContent = `${visible.length} ${visible.length === 1 ? 'record' : 'records'} shown`;
  detail.replaceChildren();
  const item = visible.find(entry => entry.id === selected);
  if (!item) { detail.append(element('p', 'detail-empty', 'Select a record to see its details.')); return; }
  const top = element('div', 'detail-top');
  const title = element('div');
  title.append(element('h3', '', item.name), element('p', '', `${item.type} · ${item.domain}`));
  top.append(mark(item), title);
  const label = element('p', 'detail-label', 'RECORD DETAILS');
  const dl = element('dl', 'detail-grid');
  for (const [key, value] of [['Environment', item.environment], ['Type', item.type], ['Service', item.service], ['Domain', item.domain]]) {
    const group = element('div'); group.append(element('dt', '', key), element('dd', '', value)); dl.append(group);
  }
  const note = element('div', 'detail-note');
  note.append(element('strong', '', 'Sample record'), element('p', '', 'This preview contains no secret value. Secure storage and sync are not available yet.'));
  detail.append(top, label, dl, note);
}
$('#total-count').textContent = String(sampleItems.length).padStart(2, '0');
$('#all-count').textContent = sampleItems.length;
search.addEventListener('input', render);
environment.addEventListener('change', render);
document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => {
  type = button.dataset.type;
  document.querySelectorAll('.tab').forEach(tab => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
  render();
}));
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); search.focus(); }
});
render();

const appearanceKey = 'hasp-preview-appearance';
let appearance;
try { appearance = normalizeAppearance(JSON.parse(localStorage.getItem(appearanceKey))); }
catch { appearance = normalizeAppearance(null); }
const designControl = $('#design');
const modeControl = $('#mode');
function applyAppearance() {
  const { design, modes } = appearance;
  document.documentElement.dataset.design = design;
  document.documentElement.dataset.mode = modes[design];
  document.documentElement.style.colorScheme = modes[design];
  designControl.value = design;
  modeControl.value = modes[design];
  const label = design === 'nightshift' ? 'Nightshift' : 'Foundry';
  $('#sidebar-design').textContent = `${label} / Preview 01`;
  $('#footer-design').textContent = `HASP / ${label.toUpperCase()}`;
  try { localStorage.setItem(appearanceKey, JSON.stringify(appearance)); } catch { /* Preferences remain available for this session. */ }
}
designControl.addEventListener('change', () => {
  appearance.design = designControl.value;
  applyAppearance();
});
modeControl.addEventListener('change', () => {
  appearance.modes[appearance.design] = modeControl.value;
  applyAppearance();
});
applyAppearance();
