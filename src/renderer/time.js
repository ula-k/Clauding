// "now", "2 min", "4 h", "4 d" — or a short date when it is older than a month.
export function relativeTime(timestampMilliseconds, translate, nowMilliseconds = Date.now()) {
  if (!timestampMilliseconds) {
    return "";
  }
  const elapsedSeconds = Math.max(0, Math.round((nowMilliseconds - timestampMilliseconds) / 1000));
  if (elapsedSeconds < 60) {
    return translate("time.now");
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return translate("time.minutes", { count: elapsedMinutes });
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return translate("time.hours", { count: elapsedHours });
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 31) {
    return translate("time.days", { count: elapsedDays });
  }
  const date = new Date(timestampMilliseconds);
  return `${date.getDate()}.${date.getMonth() + 1}`;
}
