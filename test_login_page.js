const assert = require('assert');
const fs = require('fs');
const path = require('path');

const login = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8');

assert(!login.includes('Assets/styles.css'), 'login must not inherit the application header styles');
assert(!login.includes('dumbpad-login-nav'), 'login should not render a redundant top navigation strip');
assert(!login.includes('id="theme-toggle"'), 'the removed navigation must not leave a floating theme control behind');
assert(login.includes('Assets/dumbpad-512.png'), 'the login story should retain the DumbPad PWA icon');
assert(login.includes('Assets/login.css'), 'login must keep its isolated stylesheet');
assert(login.includes('<h1>让安全留在背景里</h1>'), 'login story headline should be concise and punctuation-free');
assert(!login.includes('<h1>让安全留在背景里。</h1>'), 'login story headline should not carry a trailing full stop');
const legacyLogin = login.slice(login.indexOf('function renderLegacy()'), login.indexOf('function renderV2Login('));
assert(legacyLogin.includes('<h2>输入 PIN</h2>'), 'legacy login should use a concise task-oriented heading');
assert(!legacyLogin.includes('<h2>欢迎回来</h2>'), 'legacy login should not repeat the decorative welcome copy');

const styles = fs.readFileSync(path.join(__dirname, 'public', 'Assets', 'login.css'), 'utf8');
assert(styles.includes('font-family: "DumbPad Reading"'), 'login must load its reading font without importing application-wide CSS');
assert(styles.includes('font-family: "DumbPad Code"'), 'login must load its code font without importing application-wide CSS');
assert(styles.includes('height: 100dvh;') && styles.includes('overflow: hidden;'), 'desktop login should fit the viewport without a document scrollbar');
assert(styles.includes('white-space: nowrap;'), 'desktop login headline should remain on one line');
assert(styles.includes('.dumbpad-login-form > button[type="submit"]'), 'primary authentication buttons should have a dedicated visual treatment');

console.log('Login page checks passed');
