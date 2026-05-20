// field-scanner.test.js
// Wave 3 — node-runnable tests for the new OTP, CSRF, and challenge-layer
// detectors in field-scanner.js.
//
// Uses a minimal hand-rolled DOM mock — no jsdom dependency.
// Run: node tests/wave3/field-scanner.test.js

const {
  isOTPField,
  isCSRFHiddenInput,
  detectChallengeLayer,
} = require('../../field-scanner.js');

let passed = 0;
let failed = 0;
const fails = [];

function assert(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    fails.push(label);
    console.error('  FAIL:', label);
  }
}

// ---------- Minimal DOM mock ----------

function makeInput(attrs = {}) {
  const el = {
    tagName: 'INPUT',
    type: attrs.type || 'text',
    name: attrs.name || '',
    id: attrs.id || '',
    placeholder: attrs.placeholder || '',
    autocomplete: attrs.autocomplete || '',
    maxLength: typeof attrs.maxLength === 'number' ? attrs.maxLength : -1,
    value: attrs.value || '',
    _attrs: {
      'aria-label': attrs.ariaLabel || null,
      'maxlength': typeof attrs.maxLength === 'number' ? String(attrs.maxLength) : null,
      'autocomplete': attrs.autocomplete || null,
    },
    getAttribute(k) {
      if (k in this._attrs) return this._attrs[k];
      if (k === 'name') return this.name || null;
      if (k === 'src') return null;
      return null;
    },
  };
  return el;
}

function makeDoc({ cookie = '', iframes = [], scripts = [], turnstileEls = [] } = {}) {
  const iframeEls = iframes.map(src => ({
    tagName: 'IFRAME',
    src,
    getAttribute(k) { return k === 'src' ? src : null; },
  }));
  const scriptEls = scripts.map(src => ({
    tagName: 'SCRIPT',
    src,
    getAttribute(k) { return k === 'src' ? src : null; },
  }));
  const turnstile = turnstileEls.map(cls => ({
    tagName: 'DIV',
    className: cls,
    getAttribute() { return null; },
  }));
  return {
    cookie,
    querySelector(sel) {
      if (sel.indexOf('cf-turnstile') !== -1 && turnstile.length) return turnstile[0];
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'iframe') return iframeEls;
      if (sel === 'script[src]') return scriptEls;
      return [];
    },
  };
}

// =====================================================================
// 1. isOTPField — positive cases
// =====================================================================

// 1a. autocomplete=one-time-code wins regardless of length/type
{
  const el = makeInput({ autocomplete: 'one-time-code' });
  assert(isOTPField(el) === true, 'OTP: autocomplete=one-time-code (bare)');
}

// 1b. autocomplete=one-time-code on a normal text input
{
  const el = makeInput({ type: 'text', autocomplete: 'one-time-code', maxLength: 6 });
  assert(isOTPField(el) === true, 'OTP: one-time-code + text + maxlen 6');
}

// 1c. name=otp + text + maxlen 6
{
  const el = makeInput({ type: 'text', name: 'otp', maxLength: 6 });
  assert(isOTPField(el) === true, 'OTP: name=otp + text + maxlen 6');
}

// 1d. id contains "2fa" + number + maxlen 6
{
  const el = makeInput({ type: 'number', id: 'user-2fa-input', maxLength: 6 });
  assert(isOTPField(el) === true, 'OTP: id contains 2fa + number + maxlen 6');
}

// 1e. aria-label "Verification code" + text + maxlen 8
{
  const el = makeInput({ type: 'text', ariaLabel: 'Verification code', maxLength: 8 });
  assert(isOTPField(el) === true, 'OTP: aria-label "Verification code" + text + maxlen 8');
}

// 1f. placeholder "Enter code" + text + maxlen 4
{
  const el = makeInput({ type: 'text', placeholder: 'Enter code', maxLength: 4 });
  assert(isOTPField(el) === true, 'OTP: placeholder "Enter code" + text + maxlen 4');
}

// 1g. name=verify + tel + maxlen 6 (tel is accepted; mobile OTP UIs use type=tel)
{
  const el = makeInput({ type: 'tel', name: 'verify', maxLength: 6 });
  assert(isOTPField(el) === true, 'OTP: name=verify + tel + maxlen 6');
}

// =====================================================================
// 2. isOTPField — negative cases
// =====================================================================

// 2a. password field with otp in name — wrong type
{
  const el = makeInput({ type: 'password', name: 'otp', maxLength: 6 });
  assert(isOTPField(el) === false, 'OTP-neg: password type rejected');
}

// 2b. text + maxlen 20 + name=otp — too long
{
  const el = makeInput({ type: 'text', name: 'otp', maxLength: 20 });
  assert(isOTPField(el) === false, 'OTP-neg: maxlen 20 rejected');
}

// 2c. text + no maxlen + name=otp — missing length constraint
{
  const el = makeInput({ type: 'text', name: 'otp' });
  assert(isOTPField(el) === false, 'OTP-neg: missing maxlength rejected');
}

// 2d. text + maxlen 6 + name=email — no OTP hint
{
  const el = makeInput({ type: 'text', name: 'email', maxLength: 6 });
  assert(isOTPField(el) === false, 'OTP-neg: no OTP hint rejected');
}

// 2e. text + maxlen 3 + name=otp — too short
{
  const el = makeInput({ type: 'text', name: 'otp', maxLength: 3 });
  assert(isOTPField(el) === false, 'OTP-neg: maxlen 3 rejected');
}

// 2f. textarea with name=otp — wrong tag
{
  const el = { ...makeInput({ name: 'otp', maxLength: 6 }), tagName: 'TEXTAREA' };
  assert(isOTPField(el) === false, 'OTP-neg: non-input tag rejected');
}

// 2g. null / undefined
{
  assert(isOTPField(null) === false, 'OTP-neg: null safe');
  assert(isOTPField(undefined) === false, 'OTP-neg: undefined safe');
}

// 2h. word "decode" — contains "code" substring but should not trip (boundary check)
{
  const el = makeInput({ type: 'text', name: 'decoder', maxLength: 6 });
  assert(isOTPField(el) === false, 'OTP-neg: "decoder" does not match code (word boundary)');
}

// =====================================================================
// 3. isCSRFHiddenInput
// =====================================================================

// 3a. positive — _csrf
{
  const el = { ...makeInput({ type: 'hidden', name: '_csrf', value: 'abc' }), tagName: 'INPUT' };
  el.type = 'hidden';
  assert(isCSRFHiddenInput(el) === true, 'CSRF: hidden _csrf detected');
}

// 3b. positive — authenticity_token (Rails)
{
  const el = makeInput({ type: 'hidden', name: 'authenticity_token', value: 'xyz' });
  el.type = 'hidden';
  assert(isCSRFHiddenInput(el) === true, 'CSRF: hidden authenticity_token detected');
}

// 3c. positive — csrfmiddlewaretoken (Django)
{
  const el = makeInput({ type: 'hidden', name: 'csrfmiddlewaretoken', value: 'd' });
  el.type = 'hidden';
  assert(isCSRFHiddenInput(el) === true, 'CSRF: hidden csrfmiddlewaretoken detected');
}

// 3d. positive — __RequestVerificationToken (ASP.NET)
{
  const el = makeInput({ type: 'hidden', name: '__RequestVerificationToken', value: 'r' });
  el.type = 'hidden';
  assert(isCSRFHiddenInput(el) === true, 'CSRF: hidden __RequestVerificationToken detected');
}

// 3e. negative — visible input with csrf name (type=text)
{
  const el = makeInput({ type: 'text', name: '_csrf' });
  assert(isCSRFHiddenInput(el) === false, 'CSRF-neg: visible text rejected');
}

// 3f. negative — hidden input with non-csrf name
{
  const el = makeInput({ type: 'hidden', name: 'session_id' });
  el.type = 'hidden';
  assert(isCSRFHiddenInput(el) === false, 'CSRF-neg: hidden unrelated name rejected');
}

// 3g. negative — null safe
{
  assert(isCSRFHiddenInput(null) === false, 'CSRF-neg: null safe');
}

// =====================================================================
// 4. detectChallengeLayer
// =====================================================================

// 4a. cloudflare via cf_clearance cookie
{
  const doc = makeDoc({ cookie: 'foo=bar; cf_clearance=tokenvalue; baz=qux' });
  assert(detectChallengeLayer(doc) === 'cloudflare', 'Challenge: cf_clearance cookie');
}

// 4b. cloudflare via iframe src
{
  const doc = makeDoc({ iframes: ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/'] });
  assert(detectChallengeLayer(doc) === 'cloudflare', 'Challenge: cloudflare challenge iframe');
}

// 4c. cloudflare via cf-turnstile element
{
  const doc = makeDoc({ turnstileEls: ['cf-turnstile'] });
  assert(detectChallengeLayer(doc) === 'cloudflare', 'Challenge: cf-turnstile element');
}

// 4d. perimeterx via _pxhd cookie
{
  const doc = makeDoc({ cookie: '_pxhd=abc123; other=1' });
  assert(detectChallengeLayer(doc) === 'perimeterx', 'Challenge: _pxhd cookie');
}

// 4e. perimeterx via script src
{
  const doc = makeDoc({ scripts: ['https://client.perimeterx.net/PX12345/main.min.js'] });
  assert(detectChallengeLayer(doc) === 'perimeterx', 'Challenge: perimeterx.net script');
}

// 4f. akamai via _abck cookie
{
  const doc = makeDoc({ cookie: '_abck=ZZZ; sess=1' });
  assert(detectChallengeLayer(doc) === 'akamai', 'Challenge: _abck cookie');
}

// 4g. akamai via script src
{
  const doc = makeDoc({ scripts: ['https://target.akamaihd.net/akam-/abc.js'] });
  assert(detectChallengeLayer(doc) === 'akamai', 'Challenge: akamai script');
}

// 4h. hcaptcha via iframe
{
  const doc = makeDoc({ iframes: ['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'] });
  assert(detectChallengeLayer(doc) === 'hcaptcha', 'Challenge: hcaptcha iframe');
}

// 4i. recaptcha via iframe
{
  const doc = makeDoc({ iframes: ['https://www.google.com/recaptcha/api2/anchor?ar=1'] });
  assert(detectChallengeLayer(doc) === 'recaptcha', 'Challenge: recaptcha iframe');
}

// 4j. clean page — no challenge
{
  const doc = makeDoc({ cookie: 'sessid=abc; remember=1', iframes: ['https://youtube.com/embed/abc'], scripts: ['https://cdn.example.com/app.js'] });
  assert(detectChallengeLayer(doc) === null, 'Challenge: clean page returns null');
}

// 4k. null doc safe
{
  assert(detectChallengeLayer(null) === null, 'Challenge: null doc returns null');
}

// 4l. priority — cloudflare wins over hcaptcha when both present
{
  const doc = makeDoc({
    cookie: 'cf_clearance=t',
    iframes: ['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'],
  });
  assert(detectChallengeLayer(doc) === 'cloudflare', 'Challenge: cloudflare wins over hcaptcha');
}

// 4m. broken doc — querySelectorAll throws; should not crash, returns null
{
  const brokenDoc = {
    cookie: '',
    querySelector() { throw new Error('boom'); },
    querySelectorAll() { throw new Error('boom'); },
  };
  let threw = false;
  let result;
  try { result = detectChallengeLayer(brokenDoc); } catch { threw = true; }
  assert(!threw, 'Challenge: broken doc does not throw');
  assert(result === null, 'Challenge: broken doc returns null');
}

// =====================================================================
// Summary
// =====================================================================

if (failed === 0) {
  console.log(`field-scanner tests: ${passed} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`field-scanner tests: ${passed} passed, ${failed} failed`);
  console.error('Failed cases:');
  for (const f of fails) console.error('  -', f);
  process.exit(1);
}
