#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

const LINKEDIN_BASE = 'https://www.linkedin.com';
const SALES_HOME = 'https://www.linkedin.com/sales/';
const PROFILE_DECORATION = '(entityUrn,firstName,lastName,fullName,headline,flagshipProfileUrl,defaultPosition,positions*(companyName,current,title,companyUrn,startedOn,endedOn))';
const DEFAULT_DELAY_MS = 2500;
const FETCH_TIMEOUT_MS = 30000;

function usage() {
  return [
    'Usage:',
    '  npm run verify -- --input contacts.csv [--output result.csv] [--limit 2]',
    '',
    'Options:',
    '  --input <path>        Required input CSV',
    '  --output <path>       Output CSV path',
    '  --profile-dir <path>  Browser profile directory, default .local/linkedin-profile',
    '  --cdp-url <url>       Attach to a Chrome/Chromium instance with remote debugging enabled',
    '  --headless            Run browser without a visible window; requires a pre-authenticated profile',
    '  --delay-ms <number>   Base delay between contacts, default 2500',
    '  --limit <number>      Process only first N contacts'
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    input: '',
    output: '',
    profileDir: path.resolve('.local/linkedin-profile'),
    cdpUrl: '',
    headless: false,
    delayMs: DEFAULT_DELAY_MS,
    limit: 0
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (arg === '--input') {
      args.input = next || '';
      i += 1;
    } else if (arg === '--output') {
      args.output = next || '';
      i += 1;
    } else if (arg === '--profile-dir') {
      args.profileDir = path.resolve(next || '');
      i += 1;
    } else if (arg === '--cdp-url') {
      args.cdpUrl = next || '';
      i += 1;
    } else if (arg === '--headless') {
      args.headless = true;
    } else if (arg === '--delay-ms') {
      args.delayMs = Number(next);
      i += 1;
    } else if (arg === '--limit') {
      args.limit = Number(next);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) throw new Error('Missing required --input path.');
  args.input = path.resolve(args.input);
  if (!args.output) args.output = path.resolve(`contact-verify-${formatTimestamp()}.csv`);
  else args.output = path.resolve(args.output);
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error('--delay-ms must be a non-negative number.');
  if (!Number.isFinite(args.limit) || args.limit < 0) throw new Error('--limit must be a non-negative number.');
  args.limit = Math.floor(args.limit);
  return args;
}

function formatTimestamp(dt = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseContactsCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().replace(/[_-]+/g, ' ').trim());
  const colMap = {};
  const uuidAliases = ['uuid', 'id', 'contact id', 'record id'];
  const nameAliases = ['name', 'full name', 'fullname', 'contact name'];
  const companyAliases = ['company', 'company name', 'organization'];
  const titleAliases = ['title', 'original title', 'job title', 'role', 'position'];
  const linkedinAliases = ['linkedin', 'linkedin url', 'linkedin link', 'profile url', 'sales nav url', 'sales navigator url'];

  headers.forEach((h, i) => {
    if (uuidAliases.includes(h)) colMap.uuid = i;
    else if (nameAliases.includes(h)) colMap.name = i;
    else if (companyAliases.includes(h)) colMap.company = i;
    else if (titleAliases.includes(h)) colMap.title = i;
    else if (linkedinAliases.includes(h)) colMap.linkedin = i;
  });

  if (colMap.uuid === undefined || colMap.name === undefined || colMap.company === undefined || colMap.linkedin === undefined) {
    throw new Error('CSV needs columns: UUID, Name, Company, LinkedIn URL');
  }

  const contacts = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCSVLine(lines[i]);
    const uuid = cols[colMap.uuid] || '';
    const name = cols[colMap.name] || '';
    const company = cols[colMap.company] || '';
    const title = colMap.title !== undefined ? (cols[colMap.title] || '') : '';
    let linkedin = cols[colMap.linkedin] || '';
    if (!uuid || !name || !linkedin) continue;
    if (!linkedin.startsWith('http')) linkedin = `https://${linkedin}`;
    linkedin = linkedin.replace(/\/$/, '');
    contacts.push({ uuid, name, company, title, linkedin });
  }
  return contacts;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function resultsToCsv(results) {
  const headers = ['UUID', 'Name', 'LinkedIn Name', 'Original Company', 'Current Company', 'Status', 'Original Title', 'Current Title', 'Title Status', 'LinkedIn URL', 'Confidence', 'Strategy', 'Fetched Via'];
  const rows = [headers.join(',')];
  for (const r of results) {
    rows.push([
      r.uuid,
      r.name,
      r.linkedinName,
      r.originalCompany,
      r.currentCompany,
      r.status,
      r.originalTitle,
      r.currentTitle,
      r.titleStatus,
      r.linkedin,
      r.confidence,
      r.strategy,
      r.fetchedVia
    ].map(csvEscape).join(','));
  }
  return `${rows.join('\n')}\n`;
}

function normalizeCompany(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[.,\-–—]/g, ' ')
    .replace(/\b(inc\.?|incorporated|llc|ltd\.?|limited|corp\.?|corporation|pvt\.?|private|co\.?|company|group|holdings|technologies|technology|tech|solutions|services|consulting|plc|& co\.?)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function companiesMatch(stored, current) {
  if (!stored || !current) return { match: false, ratio: 0 };
  const a = normalizeCompany(stored);
  const b = normalizeCompany(current);
  if (!a || !b) return { match: false, ratio: 0 };
  if (a === b) return { match: true, ratio: 1.0 };
  if (a.replace(/ /g, '') === b.replace(/ /g, '')) return { match: true, ratio: 0.95 };
  const bigrams = (s) => {
    const values = [];
    for (let i = 0; i < s.length - 1; i += 1) values.push(s.slice(i, i + 2));
    return values;
  };
  const bg1 = bigrams(a);
  const bg2 = bigrams(b);
  const set2 = new Set(bg2);
  const inter = bg1.filter((bgram) => set2.has(bgram)).length;
  const ratio = (2 * inter) / (bg1.length + bg2.length) || 0;
  return { match: ratio >= 0.8, ratio };
}

function normalizeTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[.,\-–—/|()]/g, ' ')
    .replace(/\b(senior|sr|junior|jr|lead|principal|staff|the|of|and|&|at|for|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesMatch(stored, current) {
  if (!stored || !current) return { match: false, ratio: 0 };
  const a = normalizeTitle(stored);
  const b = normalizeTitle(current);
  if (!a || !b) return { match: false, ratio: 0 };
  if (a === b) return { match: true, ratio: 1.0 };
  const bigrams = (s) => {
    const values = [];
    for (let i = 0; i < s.length - 1; i += 1) values.push(s.slice(i, i + 2));
    return values;
  };
  const bg1 = bigrams(a);
  const bg2 = bigrams(b);
  const set2 = new Set(bg2);
  const inter = bg1.filter((bgram) => set2.has(bgram)).length;
  const ratio = (2 * inter) / (bg1.length + bg2.length) || 0;
  return { match: ratio >= 0.7, ratio };
}

function extractSlug(url) {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/);
  return m ? m[1].replace(/\/$/, '') : null;
}

function extractSalesNavId(url) {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/sales\/(?:lead|people)\/([^/?#]+)/);
  return m ? m[1] : null;
}

function parseSalesNavKey(salesNavId) {
  if (!salesNavId) return null;
  const parts = salesNavId.split(',');
  const key = { profileId: parts[0] };
  if (parts.length >= 3) {
    key.authType = parts[1];
    key.authToken = parts[2];
  }
  return key;
}

function normalizeCsrfToken(token) {
  return String(token || '').replace(/^"|"$/g, '');
}

function voyagerText(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && field.text) return field.text;
  return '';
}

function parseSalesElement(el) {
  if (!el) return null;
  const first = el.firstName || '';
  const last = el.lastName || '';
  const full = el.fullName || `${first} ${last}`.trim();
  const headline = el.headline || '';
  const positions = el.currentPositions || [];
  const current = positions.length > 0 ? positions[0] : null;
  let company = current ? (current.companyName || '') : '';
  let title = current ? (current.title || '') : '';
  if (!company && headline) {
    const atMatch = headline.match(/\bat\s+(.+)/i);
    if (atMatch) {
      company = atMatch[1].trim();
      if (!title) title = headline.split(/\bat\b/i)[0].trim();
    }
  }
  return { fullName: full, headline, company, title };
}

function parseSalesProfileData(data) {
  if (!data) return null;
  const fullName = data.fullName || `${data.firstName || ''} ${data.lastName || ''}`.trim();
  const headline = data.headline || '';
  const dp = data.defaultPosition;
  if (dp && dp.current && dp.companyName) {
    return { fullName, headline, company: dp.companyName, title: dp.title || '' };
  }
  const positions = data.positions || [];
  const current = positions.find((p) => p.current === true) || positions.find((p) => !p.endedOn) || null;
  return {
    fullName,
    headline,
    company: current ? (current.companyName || '') : '',
    title: current ? (current.title || '') : ''
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCsrfToken(page, context) {
  const fromPage = await page.evaluate(() => {
    const m = document.cookie.match(/(?:^|;\s*)JSESSIONID="?([^";]+)/);
    return m ? m[1] : '';
  }).catch(() => '');
  if (fromPage) return normalizeCsrfToken(fromPage);

  const cookies = await context.cookies(LINKEDIN_BASE);
  const cookie = cookies.find((c) => c.name === 'JSESSIONID');
  return normalizeCsrfToken(cookie?.value || '');
}

async function hasAuthenticatedLinkedInSession(page, csrfToken) {
  if (!csrfToken) return false;
  const res = await browserFetchJson(page, `${LINKEDIN_BASE}/voyager/api/me`, {
    method: 'GET',
    headers: { 'csrf-token': csrfToken, 'x-restli-protocol-version': '2.0.0' }
  }).catch(() => null);
  return !!(res?.ok && res.data);
}

async function browserFetchJson(page, url, options = {}) {
  const response = await page.evaluate(async ({ targetUrl, requestOptions, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(targetUrl, {
        ...requestOptions,
        credentials: 'include',
        signal: controller.signal
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      return { ok: res.ok, status: res.status, data, text: data ? '' : text.slice(0, 500) };
    } finally {
      clearTimeout(timer);
    }
  }, { targetUrl: url, requestOptions: options, timeoutMs: FETCH_TIMEOUT_MS });

  return response;
}

async function doSalesSearch(page, keywords, csrfToken) {
  const encoded = encodeURIComponent(keywords);
  const url = `${LINKEDIN_BASE}/sales-api/salesApiPeopleSearch?q=peopleSearchQuery&query=(keywords:${encoded})&count=10&start=0`;
  const res = await browserFetchJson(page, url, {
    method: 'GET',
    headers: { 'csrf-token': csrfToken, 'x-restli-protocol-version': '2.0.0' }
  });
  if (!res.ok) return [];
  return res.data?.elements || [];
}

function matchFromElements(elements, slug, salesNavId, name) {
  if (elements.length === 0) return null;
  if (salesNavId) {
    const key = parseSalesNavKey(salesNavId);
    const idToMatch = key ? key.profileId : salesNavId;
    for (const el of elements) {
      const urn = el.entityUrn || '';
      if (urn.includes(idToMatch)) return parseSalesElement(el);
    }
  }
  if (slug) {
    const slugLower = slug.toLowerCase();
    for (const el of elements) {
      const pubId = (el.publicIdentifier || '').toLowerCase();
      const flagship = (el.flagshipProfileUrl || '').toLowerCase();
      if ((pubId && pubId === slugLower) || flagship.includes(`/in/${slugLower}`)) {
        return parseSalesElement(el);
      }
    }
  }
  if (name) {
    const nameLower = name.toLowerCase();
    for (const el of elements) {
      const full = (el.fullName || '').toLowerCase();
      if (full === nameLower) return parseSalesElement(el);
    }
  }
  return null;
}

async function searchPersonByName(page, name, slug, salesNavId, company, csrfToken) {
  if (!name || !csrfToken) return null;
  if (company) {
    const elements = await doSalesSearch(page, `${name} ${company}`, csrfToken);
    const matched = matchFromElements(elements, slug, salesNavId, name);
    if (matched && matched.company) return matched;
  }
  const elements = await doSalesSearch(page, name, csrfToken);
  const matched = matchFromElements(elements, slug, salesNavId, name);
  if (matched) return matched;
  if (elements.length > 0) return parseSalesElement(elements[0]);
  return null;
}

async function fetchVoyagerProfile(page, slug, csrfToken) {
  if (!slug || !csrfToken) return null;
  const url = `${LINKEDIN_BASE}/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.TopCardSupplementary-167`;
  const res = await browserFetchJson(page, url, {
    method: 'GET',
    headers: { 'csrf-token': csrfToken, 'x-restli-protocol-version': '2.0.0' }
  });
  if (!res.ok) return null;
  const profile = res.data?.elements?.[0];
  if (!profile) return null;

  const firstName = voyagerText(profile.firstName);
  const lastName = voyagerText(profile.lastName);
  const fullName = `${firstName} ${lastName}`.trim();
  const headline = voyagerText(profile.headline);
  const urnMatch = String(profile.entityUrn || '').match(/fsd_profile:(.+)/);
  const profileId = urnMatch ? urnMatch[1] : '';

  let company = '';
  let title = '';
  const topPositions = profile.profileTopPosition?.elements || [];
  for (const pos of topPositions) {
    const companyName = voyagerText(pos.companyName);
    if (companyName) {
      company = companyName;
      title = voyagerText(pos.title);
      break;
    }
  }

  if (!company && headline) {
    const atMatch = headline.match(/\bat\s+(.+)/i);
    if (atMatch) {
      company = atMatch[1].trim();
      if (!title) title = headline.split(/\bat\b/i)[0].trim();
    }
  }

  return { fullName, headline, company, title, profileId };
}

async function fetchSalesNavProfile(page, salesNavId, csrfToken) {
  if (!salesNavId || !csrfToken) return null;
  const key = parseSalesNavKey(salesNavId);
  if (!key) return null;

  let keyStr = `profileId:${key.profileId}`;
  if (key.authType && key.authToken) {
    keyStr += `,authType:${key.authType},authToken:${key.authToken}`;
  }

  const encodedDecoration = encodeURIComponent(PROFILE_DECORATION).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const url = `${LINKEDIN_BASE}/sales-api/salesApiProfiles/(${keyStr})?decoration=${encodedDecoration}`;
  const res = await browserFetchJson(page, url, {
    method: 'GET',
    headers: { 'csrf-token': csrfToken, 'x-restli-protocol-version': '2.0.0' }
  });
  if (!res.ok) return null;
  return parseSalesProfileData(res.data);
}

function emptyResult(contact) {
  return {
    uuid: contact.uuid,
    name: contact.name,
    originalCompany: contact.company,
    originalTitle: contact.title,
    linkedin: contact.linkedin,
    status: 'Unknown',
    titleStatus: 'Unknown',
    currentCompany: '',
    currentTitle: '',
    linkedinName: '',
    confidence: 'low',
    strategy: '',
    fetchedVia: ''
  };
}

async function verifyContact(page, contact, csrfToken) {
  const result = emptyResult(contact);
  const slug = extractSlug(contact.linkedin);
  const salesNavId = extractSalesNavId(contact.linkedin);
  let parsed = null;

  if (slug && !salesNavId) {
    parsed = await fetchVoyagerProfile(page, slug, csrfToken);
    if (parsed && parsed.company) {
      result.fetchedVia = `${LINKEDIN_BASE}/voyager/api/identity/dash/profiles?memberIdentity=${slug}`;
      result.strategy = '1';
      if (parsed.profileId && (!parsed.fullName || !parsed.title)) {
        const snParsed = await fetchSalesNavProfile(page, parsed.profileId, csrfToken);
        if (snParsed) {
          if (!parsed.fullName && snParsed.fullName) parsed.fullName = snParsed.fullName;
          if (!parsed.title && snParsed.title) parsed.title = snParsed.title;
          if (!parsed.headline && snParsed.headline) parsed.headline = snParsed.headline;
        }
      }
    }
  }

  if (!parsed || !parsed.company) {
    if (salesNavId) {
      parsed = await fetchSalesNavProfile(page, salesNavId, csrfToken);
      if (parsed && parsed.company) {
        const key = parseSalesNavKey(salesNavId);
        result.fetchedVia = `${LINKEDIN_BASE}/sales-api/salesApiProfiles/(profileId:${key ? key.profileId : salesNavId})`;
        result.strategy = '1';
      }
    }
  }

  if (!parsed || !parsed.company) {
    parsed = await searchPersonByName(page, contact.name, slug, salesNavId, contact.company, csrfToken);
    if (parsed) {
      result.fetchedVia = `${LINKEDIN_BASE}/sales-api/salesApiPeopleSearch (keyword: ${contact.name} ${contact.company})`;
      result.strategy = '2';
    }
  }

  if (parsed) {
    result.linkedinName = parsed.fullName || '';
    result.currentTitle = parsed.title || parsed.headline || '';
    if (contact.title && result.currentTitle) {
      const titleCmp = titlesMatch(contact.title, result.currentTitle);
      result.titleStatus = titleCmp.match ? 'Same role' : 'Changed role';
    }
    if (parsed.company) {
      result.currentCompany = parsed.company;
      const { match, ratio } = companiesMatch(contact.company, parsed.company);
      if (match) {
        result.status = 'Still there';
        result.confidence = ratio > 0.9 ? 'high' : 'low';
      } else {
        result.status = 'Moved on';
        result.confidence = 'high';
      }
    }
  }

  return result;
}

function countResults(results) {
  return results.reduce((counts, result) => {
    if (result.status === 'Still there') counts.still += 1;
    else if (result.status === 'Moved on') counts.moved += 1;
    else counts.unknown += 1;
    return counts;
  }, { still: 0, moved: 0, unknown: 0 });
}

async function writeResults(outputPath, results) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, resultsToCsv(results), 'utf8');
}

async function ensureLinkedInSession(page, context, args) {
  await page.goto(SALES_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let csrfToken = await getCsrfToken(page, context);
  if (await hasAuthenticatedLinkedInSession(page, csrfToken)) return csrfToken;

  if (args.headless) {
    throw new Error('Headless profile is not authenticated. Refresh this profile on a desktop machine and copy it back.');
  }

  console.log('No authenticated LinkedIn session was found in this runner profile.');
  console.log('Log in to LinkedIn/Sales Navigator in the opened browser window, then press Enter here.');
  const rl = readline.createInterface({ input, output });
  await rl.question('');
  rl.close();

  await page.goto(SALES_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  csrfToken = await getCsrfToken(page, context);
  if (!(await hasAuthenticatedLinkedInSession(page, csrfToken))) {
    throw new Error('Still could not verify an authenticated LinkedIn session after login.');
  }
  return csrfToken;
}

async function launchBrowser(args) {
  if (args.cdpUrl) {
    const browser = await chromium.connectOverCDP(args.cdpUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    return {
      context,
      close: async () => {}
    };
  }

  const profileDir = args.profileDir;
  await fs.mkdir(profileDir, { recursive: true });
  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: args.headless,
      viewport: { width: 1280, height: 900 }
    });
    return { context, close: async () => context.close() };
  } catch (err) {
    console.warn(`Could not launch system Chrome: ${err.message}`);
    console.warn('Falling back to Playwright Chromium.');
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: args.headless,
      viewport: { width: 1280, height: 900 }
    });
    return { context, close: async () => context.close() };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvText = await fs.readFile(args.input, 'utf8');
  let contacts = parseContactsCSV(csvText);
  if (args.limit > 0) contacts = contacts.slice(0, args.limit);
  if (contacts.length === 0) throw new Error('No valid contacts found in input CSV.');

  console.log(`Input: ${args.input}`);
  console.log(`Output: ${args.output}`);
  console.log(args.cdpUrl ? `Browser: ${args.cdpUrl}` : `Profile: ${args.profileDir}`);
  console.log(`Contacts: ${contacts.length}`);

  const browserSession = await launchBrowser(args);
  const context = browserSession.context;
  const page = args.cdpUrl ? await context.newPage() : (context.pages()[0] || await context.newPage());
  const results = [];
  let interrupted = false;

  const handleInterrupt = async () => {
    if (interrupted) return;
    interrupted = true;
    console.log('\nInterrupted. Writing partial results...');
    await writeResults(args.output, results);
    await browserSession.close();
    process.exit(130);
  };
  process.once('SIGINT', handleInterrupt);
  process.once('SIGTERM', handleInterrupt);

  try {
    const csrfToken = await ensureLinkedInSession(page, context, args);
    console.log('LinkedIn session detected. Starting verification.');

    for (let i = 0; i < contacts.length; i += 1) {
      const contact = contacts[i];
      console.log(`[${i + 1}/${contacts.length}] ${contact.name}`);
      try {
        const result = await verifyContact(page, contact, csrfToken);
        results.push(result);
        const counts = countResults(results);
        console.log(`  ${result.status} | current company: ${result.currentCompany || 'unknown'} | still ${counts.still}, moved ${counts.moved}, unknown ${counts.unknown}`);
      } catch (err) {
        const result = emptyResult(contact);
        result.fetchedVia = `Error: ${err.message}`;
        results.push(result);
        const counts = countResults(results);
        console.log(`  Unknown | ${err.message} | still ${counts.still}, moved ${counts.moved}, unknown ${counts.unknown}`);
      }

      await writeResults(args.output, results);
      if (i < contacts.length - 1) {
        const jitter = Math.floor(Math.random() * 1000);
        await sleep(args.delayMs + jitter);
      }
    }

    const counts = countResults(results);
    console.log(`Done. Still there: ${counts.still}, moved on: ${counts.moved}, unknown: ${counts.unknown}`);
    console.log(`Saved: ${args.output}`);
  } finally {
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleInterrupt);
    await browserSession.close();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
