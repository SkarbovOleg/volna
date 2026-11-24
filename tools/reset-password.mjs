/**
 * Сброс пароля: аккаунт остаётся, меняется только пароль.
 *
 *   node tools/reset-password.mjs --list
 *   node tools/reset-password.mjs Олег новыйПароль
 */
import { openDb } from '../db.js';
import crypto from 'node:crypto';

const [, , name, password] = process.argv;
const db = openDb();

if (!name || name === '--list') {
  const users = db.prepare('SELECT id, name, created_at FROM users ORDER BY id').all();
  console.log('\nАккаунты:');
  for (const user of users) {
    console.log(`  ${user.name}  (создан ${new Date(user.created_at).toLocaleString('ru-RU')})`);
  }
  console.log('\nСброс пароля: node tools/reset-password.mjs <имя> <новый пароль>\n');
  process.exit(0);
}

if (!password || password.length < 4) {
  console.error('Пароль должен быть не короче 4 символов');
  process.exit(1);
}

const user = db.prepare('SELECT id, name FROM users WHERE name = ?').get(name);
if (!user) {
  console.error(`Нет такого аккаунта: ${name}. Запусти с --list, чтобы увидеть список.`);
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 32).toString('hex');
db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, user.id);
// старые сессии этого аккаунта закрываем, чтобы никто не остался в нём с прежним входом
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

console.log(`Пароль для ${user.name} обновлён. Все прежние сессии закрыты — войди заново.`);
