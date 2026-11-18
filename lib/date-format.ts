const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(value: string | Date) {
  if (value instanceof Date) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
}

export function formatDate(value: string | Date) {
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  return `${monthNames[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export function formatDateTime(value: string | Date) {
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  const hours = date.getUTCHours();
  const hour = hours % 12 || 12;
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(date)}, ${hour}:${minute} ${hours < 12 ? "AM" : "PM"} UTC`;
}

export function dateValue(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return dateValue(value);
}
