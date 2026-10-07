// The core gag: meet! -> meeett! -> meeettt!!
// Run: node name-stretch.js

/** @param {string} name @param {number} n escalation level (0 = first jump) */
function stretch(name, n) {
  const m = /^(.*?)([aeiou]+)([^aeiou]*)$/i.exec(name);
  const bangs = '!'.repeat(1 + Math.floor(n / 2));
  if (!m) return name + bangs; // no vowels: just shout it

  const [, head, vowels, tail] = m;
  const lastVowel = vowels[vowels.length - 1];
  const v = vowels + lastVowel.repeat(Math.ceil(n / 2));
  // name ends in a vowel -> no trailing consonant to stretch, so grow the vowels instead
  if (!tail) return head + v + lastVowel.repeat(n) + bangs;
  return head + v + tail + tail[tail.length - 1].repeat(n) + bangs;
}

/** @param {number} n */
const jumpHeight = (n) => Math.min(20 + n * 8, 120);

// --- self-check -------------------------------------------------------------
const assert = require('assert');

// the three the user actually asked for, exactly
assert.strictEqual(stretch('meet', 0), 'meet!');
assert.strictEqual(stretch('meet', 1), 'meeett!');
assert.strictEqual(stretch('meet', 2), 'meeettt!!');

// it keeps climbing, and never loses the head
assert.ok(stretch('meet', 9).startsWith('m'));
assert.ok(stretch('meet', 9).length > stretch('meet', 5).length);

// other shapes of name do not crash
assert.strictEqual(stretch('sam', 0), 'sam!');
assert.strictEqual(stretch('ria', 0), 'ria!'); // ends in a vowel
assert.strictEqual(stretch('xyz', 0), 'xyz!'); // no vowels at all

// height is capped so the pet stays inside the panel
assert.strictEqual(jumpHeight(0), 20);
assert.strictEqual(jumpHeight(50), 120);

console.log('ok\n');
for (let n = 0; n < 8; n++) {
  console.log(String(jumpHeight(n)).padStart(4) + 'px  ' + stretch('meet', n));
}

module.exports = { stretch, jumpHeight };
