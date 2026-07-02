#!/usr/bin/env node
/**
 * Send the internship digest created by scripts/internship-scan.mjs.
 *
 * Preferred: SENDGRID_API_KEY + EMAIL_FROM + EMAIL_TO.
 * Fallback: SMTP_HOST/SMTP_PORT + EMAIL_USERNAME + EMAIL_PASSWORD + EMAIL_TO.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

const DIGEST_JSON = process.env.DIGEST_JSON || 'output/internship-digest.json';
const SEND_EMPTY_DIGEST = /^(1|true|yes)$/i.test(process.env.SEND_EMPTY_DIGEST || '');
const DRY_RUN = process.argv.includes('--dry-run');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadDigest() {
  if (!existsSync(DIGEST_JSON)) {
    throw new Error(`Digest JSON not found: ${DIGEST_JSON}`);
  }
  return JSON.parse(readFileSync(DIGEST_JSON, 'utf-8'));
}

function buildMessage(digest) {
  const items = Array.isArray(digest.items) ? digest.items : [];
  const date = new Date(digest.generatedAt || Date.now()).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const subject = items.length > 0
    ? `Neel 2027 internship digest: ${items.length} new match${items.length === 1 ? '' : 'es'}`
    : 'Neel 2027 internship digest: no new matches';

  const textLines = [
    `2027 Internship Digest - ${date}`,
    '',
    `New matching postings: ${items.length}`,
    '',
  ];

  for (const item of items) {
    textLines.push([
      `${item.company} - ${item.title}`,
      `Location: ${item.location || 'N/A'}`,
      `Term: ${item.term || 'N/A'}`,
      `Score: ${item.score}/5`,
      `Why: ${item.why || 'Matches target internship filters.'}`,
      `Suggested action: ${item.suggestedAction}`,
      `Date found: ${item.firstSeen}`,
      `URL: ${item.url}`,
      '',
    ].join('\n'));
  }

  if (items.length === 0) {
    textLines.push('No new matching postings met the score threshold.');
  }

  const rows = items.map(item => `
    <tr>
      <td>${escapeHtml(item.company)}</td>
      <td>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(item.location || 'N/A')}</td>
      <td>${escapeHtml(item.term || 'N/A')}</td>
      <td>${escapeHtml(item.score)}/5</td>
      <td>${escapeHtml(item.why || 'Matches target internship filters.')}</td>
      <td>${escapeHtml(item.suggestedAction)}</td>
      <td>${escapeHtml(item.firstSeen)}</td>
      <td><a href="${escapeHtml(item.url)}">Posting</a></td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827;">
      <h2>2027 Internship Digest - ${escapeHtml(date)}</h2>
      <p><strong>New matching postings:</strong> ${items.length}</p>
      ${items.length > 0 ? `
        <table cellpadding="8" cellspacing="0" border="1" style="border-collapse: collapse; border-color: #d1d5db; font-size: 14px;">
          <thead>
            <tr style="background: #f3f4f6;">
              <th>Company</th>
              <th>Role</th>
              <th>Location</th>
              <th>Term</th>
              <th>Score</th>
              <th>Why it matches Neel</th>
              <th>Action</th>
              <th>Date found</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<p>No new matching postings met the score threshold.</p>'}
      <p style="margin-top: 16px; color: #4b5563;">No applications were submitted automatically.</p>
    </div>
  `;

  return { subject, text: textLines.join('\n'), html };
}

async function sendWithSendGrid({ to, from, subject, text, html }) {
  const apiKey = requireEnv('SENDGRID_API_KEY');
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SendGrid failed with HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
}

async function sendWithSmtp({ to, from, subject, text, html }) {
  const nodemailer = await import('nodemailer');
  const username = requireEnv('EMAIL_USERNAME');
  const password = requireEnv('EMAIL_PASSWORD');
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.default.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: username, pass: password },
  });

  await transporter.sendMail({ from, to, subject, text, html });
}

async function main() {
  const digest = loadDigest();
  const items = Array.isArray(digest.items) ? digest.items : [];

  if (items.length === 0 && !SEND_EMPTY_DIGEST) {
    console.log('No digest email sent: no new matching postings.');
    return;
  }

  const to = requireEnv('EMAIL_TO');
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USERNAME || '';
  if (!from) throw new Error('Missing EMAIL_FROM or EMAIL_USERNAME.');

  const message = { to, from, ...buildMessage(digest) };
  if (DRY_RUN) {
    console.log(`[dry-run] Would send "${message.subject}" to ${to} from ${from}`);
    console.log(message.text);
    return;
  }

  if (process.env.SENDGRID_API_KEY) {
    await sendWithSendGrid(message);
  } else {
    await sendWithSmtp(message);
  }

  console.log(`Digest email sent to ${to}`);
}

main().catch(err => {
  console.error(`Digest send failed: ${err.message}`);
  process.exit(1);
});
