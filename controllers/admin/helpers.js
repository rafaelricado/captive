const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE || 'America/Sao_Paulo';
const PAGE_SIZE = 50;
const MAC_RE_STRICT = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

function maskCpf(cpf) {
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

function formatDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('pt-BR', { timeZone: DISPLAY_TIMEZONE });
}

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return parseFloat((n / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function startOfWeek() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function escapeCSV(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

module.exports = {
  DISPLAY_TIMEZONE, PAGE_SIZE, MAC_RE_STRICT,
  maskCpf, formatDate, startOfDay, formatBytes, startOfWeek, escapeCSV
};
