// Real local app + synthetic fixture only. See docs/PWA.md for setup and replay.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { webkit, chromium, devices } from 'playwright-core';

const origin = process.env.MOBILE_ORIGIN ?? 'http://127.0.0.1:3147';
const fixtureDir = resolve(process.env.MOBILE_FIXTURE_DIR ?? '');
const output = resolve(process.env.MOBILE_EVIDENCE_DIR ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Use an isolated loopback app');
for (const dir of [fixtureDir, output]) {
  assert(relative(process.cwd(), dir).startsWith('..'), 'Keep fixtures and evidence outside git');
}
const credentials = JSON.parse(readFileSync(resolve(fixtureDir, 'fixture-secrets.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(resolve(fixtureDir, 'fixture.json'), 'utf8'));
mkdirSync(output, { recursive: true });
const results = [];
const engine = process.env.MOBILE_ENGINE ?? 'webkit';
assert(['webkit', 'chromium'].includes(engine));
const serviceWorkers = process.env.MOBILE_SERVICE_WORKERS ?? 'allow';
assert(['allow', 'block'].includes(serviceWorkers));
const browser = await ({ webkit, chromium }[engine]).launch();
const context = await browser.newContext({
  ...devices['iPhone 13'], viewport: { width: 390, height: 844 },
  colorScheme: 'dark', ignoreHTTPSErrors: true,
  serviceWorkers,
});
await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const suffix = Date.now().toString(36);
const pending = new Set();
let lastRequest = Date.now();
page.on('request', request => { pending.add(request); lastRequest = Date.now(); });
for (const event of ['requestfinished', 'requestfailed']) {
  page.on(event, request => { pending.delete(request); lastRequest = Date.now(); });
}

async function settle() {
  // Include debounced filters and response bodies before leaving the current page.
  if (engine === 'chromium') {
    await page.waitForTimeout(350);
    await page.waitForLoadState('networkidle');
    return;
  }
  const deadline = Date.now() + 15000;
  while (pending.size || Date.now() - lastRequest < 750) {
    assert(Date.now() < deadline, `Page requests must settle: ${[...pending].map(r => r.url()).join(', ')}`);
    await page.waitForTimeout(100);
  }
}

async function navigate(url) {
  await settle();
  await page.goto(url);
  await settle();
}

async function layout(name, { dates = true, screenshot = false } = {}) {
  const showDate = name.endsWith('-date') || name === 'date-text150';
  if (showDate) await page.locator('input[type=date]').first().evaluate(e => e.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const data = await page.evaluate(() => {
    const rect = e => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const root = [...document.querySelectorAll('[role=dialog]')].at(-1) ?? document.querySelector('main') ?? document.body;
    const overflow = [];
    const scrollReachability = [];
    for (const e of root.querySelectorAll('input:not([type=hidden]),select,textarea,button,[role=radio]')) {
      if (!e.getClientRects().length) continue;
      const label = e.getAttribute('aria-label') || e.closest('label')?.innerText || e.textContent;
      const restored = [];
      for (let p = e.parentElement; p && p !== root; p = p.parentElement) {
        const overflowX = getComputedStyle(p).overflowX;
        if (!['hidden', 'clip', 'auto', 'scroll'].includes(overflowX)) continue;
        let r = rect(e);
        const pr = rect(p);
        if (r.left >= pr.left - 1 && r.right <= pr.right + 1) continue;
        if (['auto', 'scroll'].includes(overflowX) && p.scrollWidth > p.clientWidth && r.width <= p.clientWidth) {
          const before = { rect: r, scrollLeft: p.scrollLeft };
          restored.push([p, p.scrollLeft]);
          p.scrollLeft += r.right > pr.right ? r.right - pr.right : r.left - pr.left;
          r = rect(e);
          scrollReachability.push({ label, before, after: { rect: r, scrollLeft: p.scrollLeft }, ancestor: pr });
        }
        if (r.left < pr.left - 1 || r.right > pr.right + 1) {
          overflow.push({ label, rect: r, cause: 'clipping ancestor', ancestor: pr });
          break;
        }
      }
      const r = rect(e);
      if (r.left < -1 || r.right > innerWidth + 1) overflow.push({ label, rect: r, cause: 'viewport' });
      for (const [scroller, left] of restored.reverse()) scroller.scrollLeft = left;
    }
    const dateControls = [...root.querySelectorAll('input[type=date]')].map(e => {
      // Measure the engine's native segments at the same font, without altering the live control.
      const clone = e.cloneNode();
      Object.assign(clone.style, { width: 'max-content', maxWidth: 'none', position: 'absolute', visibility: 'hidden' });
      e.parentElement.append(clone);
      const intrinsicWidth = clone.getBoundingClientRect().width;
      clone.remove();
      const r = e.getBoundingClientRect();
      const unobstructed = [[r.left + 10, r.top + 10], [r.right - 10, r.top + 10], [r.left + 10, r.bottom - 10], [r.right - 10, r.bottom - 10]].every(([x, y]) => document.elementFromPoint(x, y) === e);
      return { value: e.value, unobstructed, rect: rect(e), parent: rect(e.parentElement), intrinsicWidth, appearance: getComputedStyle(e).appearance };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, scrollY },
      dateControls, overflow, scrollReachability,
    };
  });
  results.push({ name, engine, ...data });
  writeFileSync(resolve(output, 'measurements.json'), JSON.stringify(results, null, 2));
  if (screenshot) await page.screenshot({ path: resolve(output, `${name}.png`), scale: 'css' });
  assert.equal(data.overflow.length, 0, `${name}: clipped controls ${JSON.stringify(data.overflow)}`);
  for (const d of data.dateControls) {
    if (showDate) assert(d.unobstructed, `${name}: part of the date control is covered`);
    assert(d.rect.left >= d.parent.left - 1 && d.rect.right <= d.parent.right + 1, `${name}: date escapes its field`);
    // Desktop WebKit exposes fixed date segments. Chromium reserves extra picker space in max-content.
    if (dates && engine === 'webkit') assert(d.rect.width + 1 >= d.intrinsicWidth, `${name}: native date text clips`);
  }
  if (data.viewport.width < 768) {
    assert.equal(data.document.width, data.viewport.width, `${name}: document horizontal overflow`);
    assert.equal(data.document.height, data.viewport.height, `${name}: document scroll escapes app frame`);
    assert.equal(data.document.scrollY, 0, `${name}: document moved`);
  }
  console.log(JSON.stringify({ name, result: 'pass', dates: data.dateControls.map(d => ({ width: d.rect.width, native: d.intrinsicWidth })) }));
}
async function group() {
  await navigate(`${origin}/groups/${fixture.groupId}`);
  await page.getByRole('button', { name: 'Group menu', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settle up', exact: true }).waitFor();
}
async function expense() {
  await navigate(`${origin}/groups/${fixture.groupId}?add=1`);
  await page.getByRole('dialog', { name: 'Add expense', exact: true }).waitFor();
  await page.getByLabel('Date', { exact: true }).waitFor();
  await page.waitForTimeout(350);
}
async function close() {
  const dialog = page.getByRole('dialog').last();
  const title = await dialog.getAttribute('aria-label');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('dialog', { name: title, exact: true }).waitFor({ state: 'hidden' });
}
async function reachFooter(name, screenshot = false) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Add note or receipt', exact: true }).click();
  const note = dialog.locator('textarea');
  await note.fill('Synthetic mobile layout receipt');
  const tabKey = engine === 'webkit' ? 'Alt+Tab' : 'Tab';
  await note.press(tabKey);
  const submit = dialog.locator('button[type=submit]');
  for (let i = 0; i < 12 && !await submit.evaluate(e => e === document.activeElement); i++) await page.keyboard.press(tabKey);
  assert(await submit.evaluate(e => e === document.activeElement), 'Keyboard can reach save');
  const scroll = await dialog.evaluate(root => {
    const scroller = [...root.querySelectorAll('div')].find(e => getComputedStyle(e).overflowY === 'auto');
    const before = scroller.scrollTop;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: scroller.scrollHeight, bubbles: true }));
    scroller.scrollTop = scroller.scrollHeight;
    const note = root.querySelector('textarea').getBoundingClientRect();
    const footer = root.querySelector('button[type=submit]').parentElement.getBoundingClientRect();
    return { before, after: scroller.scrollTop, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight, noteBottom: note.bottom, footerTop: footer.top };
  });
  assert(scroll.after > 0, 'Long form actually scrolls');
  assert(scroll.noteBottom <= scroll.footerTop + 1, 'Final field can scroll above footer');
  const visible = await submit.evaluate(e => {
    const r = e.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  assert(visible, 'Save is inside viewport and unobstructed');
  results.push({ name: `${name}-scroll`, ...scroll });
  await layout(name, { screenshot });
}
async function saveExpense(method, tag) {
  await expense();
  const title = `Mobile ${tag} ${suffix}`;
  await page.getByLabel('Amount', { exact: true }).fill('30');
  await page.getByLabel('Description', { exact: true }).fill(title);
  const date = page.getByLabel('Date', { exact: true });
  await date.click();
  await date.fill('2026-10-08');
  assert.equal(await date.inputValue(), '2026-10-08');
  await page.getByRole('radio', { name: 'Equal', exact: true }).click();
  await page.getByRole('radio', { name: method, exact: true }).click();
  if (method === 'Exact amounts') {
    for (const input of await page.getByRole('textbox', { name: /^Exact amounts for / }).all()) await input.fill('10');
  }
  if (method === 'Itemized bill') {
    await page.getByRole('button', { name: 'Add item', exact: true }).click();
    await page.getByLabel('Item 1 name', { exact: true }).fill('Fixture meal');
    await page.getByLabel('Item 1 amount', { exact: true }).fill('30');
    while (await page.locator('button[aria-pressed=false]').count()) await page.locator('button[aria-pressed=false]').first().click();
  }
  await reachFooter(`persist-${tag}`);
  const saved = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/groups/${fixture.groupId}/expenses`);
  await page.getByRole('dialog', { name: 'Add expense', exact: true }).getByRole('button', { name: 'Add expense', exact: true }).click();
  const response = await saved;
  assert(response.ok(), `Create expense: ${response.status()}`);
  const { id } = await response.json();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await settle();
  await page.reload();
  await settle();
  await page.getByRole('textbox', { name: 'Search expenses', exact: true }).fill(title);
  await page.getByRole('button', { name: `View ${title}`, exact: true }).click();
  await page.getByRole('dialog', { name: title, exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit expense', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Date', { exact: true }).inputValue(), '2026-10-08');
  await page.getByLabel('Date', { exact: true }).fill('2026-10-09');
  const edited = page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/expenses/${id}`);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  assert((await edited).ok(), 'Edit expense succeeds');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const { expense: persisted } = await (await page.request.get(`${origin}/api/expenses/${id}`)).json();
  assert.equal(persisted.date.slice(0, 10), '2026-10-09');
  assert.equal(persisted.amountCents, 3000);
  results.push({ name: `persistence-${tag}`, id, date: persisted.date, amountCents: persisted.amountCents, splitMethod: persisted.splitMethod });
}

try {
  await navigate(`${origin}/login`);
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  const homeReady = page.waitForResponse(r => new URL(r.url()).pathname === '/api/activity' && r.ok());
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.waitForURL(`${origin}/`);
  await homeReady;
  await settle();
  // Current main allocates 162px for 185px of native date segments at this text size.
  await page.locator('button[aria-label="Add expense"]:visible').click();
  await page.getByLabel('Date', { exact: true }).waitFor();
  await page.getByRole('radio', { name: 'One person', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/', 'Global Add opens in place on Home');
  await page.waitForTimeout(350);
  await layout('home-add-date', { screenshot: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = '150%'; });
  await page.getByLabel('Date', { exact: true }).scrollIntoViewIfNeeded();
  await layout('date-text150', { screenshot: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });

  await page.setViewportSize({ width: 360, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const amount = page.getByLabel('Amount', { exact: true });
  await amount.evaluate(e => e.scrollIntoView({ block: 'center' }));
  const largeText = await page.evaluate(() => {
    const amount = document.querySelector('#expense-amount');
    const label = amount.closest('label').querySelector('span');
    const currency = [...document.querySelectorAll('label')].find(e => e.querySelector('span')?.textContent === 'Currency');
    const range = document.createRange();
    range.selectNodeContents(label);
    const a = range.getBoundingClientRect(), c = currency.getBoundingClientRect();
    return { overlap: a.right > c.left && a.bottom > c.top && a.top < c.bottom, amountWidth: amount.getBoundingClientRect().width };
  });
  assert(!largeText.overlap && largeText.amountWidth >= 200, 'Large-text amount and currency remain readable');
  results.push({ name: 'amount-text200', ...largeText });
  await layout('amount-text200', { dates: false, screenshot: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });

  for (const [width, height] of [[320,568], [390,844], [393,852], [430,932], [844,390], [390,430], [1280,900]]) {
    await page.setViewportSize({ width, height });
    const key = `${width}x${height}`;
    await expense();
    await page.getByLabel('Date', { exact: true }).scrollIntoViewIfNeeded();
    await layout(`${key}-date`, { screenshot: width === 320 || height === 844 || width === 1280 });
    await page.getByRole('button', { name: 'New category', exact: true }).click();
    await page.getByLabel('New category name', { exact: true }).fill(`Mobile ${key} ${suffix}`);
    await layout(`${key}-new-category`);
    const created = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/categories');
    await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
    assert((await created).ok(), 'Category creation succeeds');
    await page.getByLabel('New category name', { exact: true }).waitFor({ state: 'hidden' });
    assert.notEqual(await page.locator('#expense-category').inputValue(), '');
    for (const method of ['One person', 'Equal', 'Exact amounts', 'Percentages', 'Shares', 'Itemized bill']) {
      await page.getByRole('radio', { name: method, exact: true }).click();
      if (method === 'Itemized bill') {
        await page.getByRole('button', { name: 'Add item', exact: true }).click();
        await page.getByLabel('Item 1 name', { exact: true }).fill('Fixture item');
        await page.getByLabel('Item 1 amount', { exact: true }).fill('30');
        while (await page.locator('button[aria-pressed=false]').count()) await page.locator('button[aria-pressed=false]').first().click();
        await page.getByLabel('Item 1 name', { exact: true }).scrollIntoViewIfNeeded();
      }
      await layout(`${key}-${method.replaceAll(' ', '-')}`, { screenshot: width === 390 && height === 844 && method === 'Itemized bill' });
    }
    await reachFooter(`${key}-footer`, width === 320 || height === 844 || height === 430);
    await close();
    await group();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByLabel('From date', { exact: true }).fill('2026-10-01');
    await page.getByLabel('To date', { exact: true }).fill('2026-10-31');
    await layout(`${key}-group-filters`);
    await page.getByRole('button', { name: 'Settle up', exact: true }).click();
    const otherPayment = page.getByRole('button', { name: 'Record a different payment', exact: true });
    if (await otherPayment.isVisible()) await otherPayment.click();
    await page.getByLabel('Date', { exact: true }).fill('2026-10-09');
    await layout(`${key}-settlement`);
    await close();
    await page.locator('[data-group-tab="balances"]:visible').click();
    await page.getByRole('button', { name: 'Add group balance', exact: true }).click();
    await page.getByLabel('Total to settle', { exact: true }).fill('30');
    await page.getByLabel('Description', { exact: true }).fill('Synthetic preview');
    await page.getByRole('button', { name: 'Create group balance', exact: true }).scrollIntoViewIfNeeded();
    await layout(`${key}-group-balance`);
    await close();
    await page.getByRole('button', { name: 'Group menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Group settings', exact: true }).click();
    await page.getByRole('button', { name: 'Delete group', exact: true }).scrollIntoViewIfNeeded();
    await layout(`${key}-group-settings`);
    await close();
    await page.getByRole('button', { name: 'Group menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Recurring expenses', exact: true }).click();
    await page.getByRole('button', { name: 'Add recurring', exact: true }).click();
    await page.getByLabel('First date', { exact: true }).fill('2027-01-15');
    await layout(`${key}-recurring`);
    await close();
    await close();
    for (const route of ['/expenses', '/settings', '/groups', '/balances', '/activity', '/chat', '/notifications', '/']) {
      await navigate(origin + route);
      await page.locator('.app-frame').waitFor();
      await page.waitForFunction(() => !document.querySelector('.skeleton'));
      if (route === '/chat' && width >= 1024) {
        await page.waitForURL(url => url.pathname === '/chat' && url.search.length > 0);
        await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
      }
      if (route === '/expenses') {
        if (width < 768) await page.getByRole('button', { name: 'Filters', exact: true }).click();
        await page.getByLabel('From date', { exact: true }).fill('2026-10-01');
        await page.getByLabel('To date', { exact: true }).fill('2026-10-31');
      }
      if (route === '/settings') {
        await page.getByRole('button', { name: 'Change password', exact: true }).scrollIntoViewIfNeeded();
      }
      await layout(`${key}-route-${route.slice(1) || 'home'}`);
      if (route === '/notifications') {
        const unread = page.getByRole('radio', { name: /^Unread/ });
        await unread.click();
        assert.equal(await unread.getAttribute('aria-checked'), 'true');
        const visible = await unread.evaluate(e => {
          const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect();
          return r.left >= p.left && r.right <= p.right && r.left >= 0 && r.right <= innerWidth
            && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        });
        assert(visible, 'Unread filter is fully reachable by horizontal scrolling');
        results.push({ name: `${key}-notification-filter-scroll`, selected: true, unobstructed: visible });
        await page.getByRole('radio', { name: 'All', exact: true }).click();
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [method, tag] of [['One person', 'solo'], ['Equal', 'equal'], ['Exact amounts', 'exact'], ['Itemized bill', 'itemized']]) await saveExpense(method, tag);
  await navigate(`${origin}/chat?g=${fixture.groupId}`);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(`Synthetic mobile click ${suffix}`);
  await page.setViewportSize({ width: 390, height: 430 });
  await composer.focus();
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const beforePress = await send.boundingBox();
  const sent = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/groups/${fixture.groupId}/messages`);
  await page.mouse.move(beforePress.x + beforePress.width / 2, beforePress.y + beforePress.height / 2);
  await page.mouse.down();
  const duringPress = await send.boundingBox();
  assert.equal(duringPress.y, beforePress.y, 'Send must not move away from the pointer during a press');
  await page.mouse.up();
  assert((await sent).ok(), 'Send reaches the real local messages API');
  await page.waitForFunction(() => document.querySelector('.chat-composer-input').value === '');
  results.push({ name: 'chat-send-stable', beforePress, duringPress, persisted: true });
  await layout('chat-send', { screenshot: true });
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Mobile layout and persisted date interactions passed. Desktop engine emulation; no physical iPhone claim.');
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png'), scale: 'css' }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(output, 'measurements.json'), JSON.stringify({ engine, serviceWorkers, results, errors }, null, 2));
  await browser.close();
}
