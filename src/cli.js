// Administration commands for the web version, run on the server, for example:
//   docker exec -it agent-runner node src/cli.js set-password   asks for a new sign-in password (typing stays hidden)
//   docker exec agent-runner node src/cli.js new-password       makes a new easy-to-say password and saves it in
//                                                               data/initial-password.txt (never printed)
// Both sign everybody out. The running app keeps working; it reads the password from the shared database.
import readline from 'node:readline';
import { setPassword, newPassword, MIN_PASSWORD_LENGTH } from './auth.js';
import { db } from './db.js';

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
      if (text.includes(question)) rl.output.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, '');
}

async function main() {
  const command = process.argv[2];
  if (command === 'new-password') {
    const file = newPassword();
    console.log(`A new sign-in password was saved in ${file}. Everybody has been signed out.`);
    return 0;
  }
  if (command === 'set-password') {
    let password;
    if (process.stdin.isTTY) {
      password = await askHidden(`New sign-in password (at least ${MIN_PASSWORD_LENGTH} characters): `);
      if ((await askHidden('The same password again: ')) !== password) {
        console.error('The two passwords are different. Nothing was changed.');
        return 1;
      }
    } else {
      password = await readStdin();
    }
    setPassword(password);
    console.log('The sign-in password was changed. Everybody has been signed out.');
    return 0;
  }
  console.log('Usage: node src/cli.js set-password | new-password');
  return command ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(err.message);
} finally {
  db.close();
}
process.exit(code);
