// scripts/encrypt-password.js
const readline = require('readline');

// Generate a random secret if needed
if (!process.env.BOT_SECRET) {
  const secret = require('crypto').randomBytes(32).toString('hex');
  console.log('\n=== FIRST TIME SETUP ===');
  console.log('Add this to ecosystem.config.js BOT_SECRET env:');
  console.log(secret);
  console.log('Then re-run: BOT_SECRET=' + secret + ' node scripts/encrypt-password.js\n');
  process.exit(0);
}

const { encrypt } = require('../src/config');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Enter your eToro password: ', (password) => {
  const result = encrypt(password.trim());
  console.log('\nPaste this into config.json → etoro.password:');
  console.log(result);
  rl.close();
});
