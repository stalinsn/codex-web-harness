// Number, date and duration formatting (pt-BR).

export function formatNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('pt-BR', { notation: Number(value) >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value));
}

export function formatReset(timestamp) {
  if (!timestamp) return 'reinício não informado';
  const date = new Date(Number(timestamp) * 1000);
  if (Number.isNaN(date.getTime())) return 'reinício não informado';
  return `reinicia ${new Intl.DateTimeFormat('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date)}`;
}

export function formatCountdown(timestamp) {
  const remaining = Math.ceil((Number(timestamp) * 1000 - Date.now()) / 1000);
  if (!Number.isFinite(remaining)) return '';
  if (remaining <= 0) return 'em breve';
  if (remaining < 60) return 'em <1 min';
  if (remaining < 3600) return `em ${Math.ceil(remaining / 60)} min`;
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.ceil((remaining % 3600) / 60);
  if (remaining < 86400) return minutes ? `em ${hours} h ${minutes} min` : `em ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  const days = Math.floor(hours / 24);
  return `em ${days} ${days === 1 ? 'dia' : 'dias'}${hours % 24 ? ` e ${hours % 24} h` : ''}`;
}

export function effortLabel(value) {
  return ({ none: 'Desligado', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo', ultra: 'Ultra' })[value] || value;
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) { scaled /= 1024; unit += 1; }
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(scaled)} ${units[unit]}`;
}
