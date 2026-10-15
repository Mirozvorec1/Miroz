// Генератор страниц проектов.
//
// Читает список проектов из Firestore и создаёт для каждого реальный
// html-файл <slug>.html в корне сайта (на основе board.html).
//
// Запуск:
//   1) npm install
//   2) положить ключ service account в ./serviceAccountKey.json
//   3) npm run pages
//
// Ключ: Firebase Console → Project settings → Service accounts →
// Generate new private key. Файл НЕ коммитить (см. .gitignore).

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const ROOT = path.resolve(__dirname, '..');
const KEY_PATH = path.join(ROOT, 'serviceAccountKey.json');
const TEMPLATE = path.join(ROOT, 'board.html');
const MARKER = '<!-- PROJECT_ID -->';

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function main() {
  if (!fs.existsSync(KEY_PATH)) {
    console.error('Не найден serviceAccountKey.json.\n' +
      'Firebase Console → Project settings → Service accounts → Generate new private key,\n' +
      'сохраните файл как ' + KEY_PATH);
    process.exit(1);
  }

  const serviceAccount = require(KEY_PATH);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  if (!template.includes(MARKER)) {
    console.error('В board.html не найден маркер ' + MARKER);
    process.exit(1);
  }

  const snap = await db.collection('projects').get();
  if (snap.empty) {
    console.log('Проектов нет — файлы не созданы.');
    return;
  }

  for (const doc of snap.docs) {
    const slug = doc.id;
    const data = doc.data() || {};
    const name = data.name || slug;

    let html = template
      .replace(MARKER, '<script>window.PROJECT_ID = ' + JSON.stringify(slug) + ';</script>')
      .replace('<title>Доска — Miroz</title>', '<title>' + escapeHtml(name) + ' — Miroz</title>');

    fs.writeFileSync(path.join(ROOT, slug + '.html'), html);
    console.log('  + ' + slug + '.html  (' + name + ')');
  }

  console.log('\nГотово: ' + snap.size + ' страниц(ы). Не забудьте закоммитить новые файлы.');
}

main().catch(err => { console.error(err); process.exit(1); });
