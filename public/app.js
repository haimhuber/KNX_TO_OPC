async function parseText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const points = [];

  for (const line of lines) {
    const parts = line.split(/[,;\t]+/).map(p => p.trim());
    let ga = null;
    let name = null;

    for (const p of parts) {
      if (/^\d+\/\d+\/\d+$/.test(p)) { ga = p; break; }
    }

    if (!ga && parts.length >= 1) {
      const m = parts[0].match(/(\d+[\./]\d+[\./]\d+)\s*(.*)/);
      if (m) { ga = m[1].replace(/[.,]/g, '/'); name = m[2]; }
    }

    if (!name && parts.length >= 2) name = parts.slice(1).join(' - ');

    if (ga) points.push({ ga, dst: name || '' });
  }

  return points;
}

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip = document.getElementById('ip').value.trim();
  const fileInput = document.getElementById('etsfile');
  if (!ip || !fileInput.files.length) return alert('נא למלא IP ולבחור קובץ');

  const file = fileInput.files[0];
  const text = await file.text();
  const points = await parseText(text);

  const preview = document.getElementById('preview');
  if (!points.length) preview.innerText = 'לא נמצאו כתובות בקובץ';
  else preview.innerHTML = points.map(p => `<div>${p.ga} — ${p.dst}</div>`).join('');

  if (!confirm(`ייבא ${points.length} נקודות ל-IP ${ip}?`)) return;

  const form = new FormData();
  form.append('ip', ip);
  form.append('etsfile', file);

  const res = await fetch('/api/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (res.ok) {
    alert('הצלחה: ' + (json.added || 0) + ' נקודות נוספו');
  } else {
    alert('שגיאה: ' + (json.error || res.statusText));
  }
});
