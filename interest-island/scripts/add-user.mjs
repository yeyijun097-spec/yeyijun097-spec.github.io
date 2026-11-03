import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/database.js";

const username = process.argv[2];
const password = process.argv[3];
const role = process.argv[4] === "admin" ? "admin" : "user";

if (!username || !password) {
  console.error("用法：CONFIG=config/production.json node scripts/add-user.mjs <用户名> <初始密码> [admin|user]");
  process.exit(1);
}

const config = loadConfig(process.env.CONFIG || "config/default.json");
const database = createDatabase(config);
try {
  const user = database.users.create({ username, password, role, mustChangePassword: true });
  console.log(`已创建用户：${user.username}（${user.role}），首次登录必须修改密码。`);
} catch (error) {
  console.error(`创建失败：${error.message}`);
  process.exitCode = 1;
} finally {
  database.close();
}
