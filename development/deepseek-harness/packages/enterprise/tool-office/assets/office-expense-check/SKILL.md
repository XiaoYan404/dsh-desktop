---
name: office-expense-check
description: Check supplied reimbursement entries and explicit company rules with exact native-workflow arithmetic, duplicate receipt and missing-field checks, then deliver a review report. Report missing evidence or rules; never approve reimbursement, send a claim or initiate payment.
---

# Reimbursement evidence check

Use the user's language. Read the supplied ledger, receipts and company rules through native `read` or currently authorized office readers. For a spreadsheet or PDF, use only installed readers and retain the original source references. Do not invent an invoice, amount, date, currency precision, exchange rate, spending limit or approval conclusion. Unreadable scans, unavailable readers, missing evidence and missing company rules must remain visible as limitations.

The exact arithmetic workflow below consumes an explicitly sourced JSON ledger and JSON rule document. If source receipts need extraction first, write and reread a ledger containing only verified facts and source references; mark unresolved fields empty and disclose that extraction needs review. Do not substitute a guessed policy. Work only on new files; preserve the original receipts and rules.

Ledger `entries` contain `id`, `amount` as a nonnegative decimal string, `currency`, and the source fields required by the rules, such as `date`, `receipt` and `source`. `claimedTotals` contains `{ "currency": "CNY", "amount": "250.00" }` rows when a total was actually claimed. Rules explicitly state `currencyScale` (for example `{ "CNY": 2 }`), `perItemLimits` (decimal strings by currency) and `requiredFields` (field names). An empty limit map means amount limits were not supplied and must be reported as unchecked. No currency conversion, tax, rounding or refund arithmetic is inferred.

## Check and review

Run native `workflow` in the foreground with meta name `office-expense-check`, description `Check reimbursement evidence and rules`, and phases `Check` and `Review`. Pass the actual JSON document text as `args.material` and `args.policy`. Amounts use integer minor units inside the script; totals from different currencies remain separate. Invalid or absent amounts are excluded and reported, never converted to zero or rounded.

```javascript
if (typeof args.material !== 'string' || !args.material.trim()) {
  throw new Error('Actual reimbursement entries are required before checking.');
}
if (typeof args.policy !== 'string' || !args.policy.trim()) {
  throw new Error('Explicit company reimbursement rules are required before checking.');
}
const ledger = JSON.parse(args.material);
const policy = JSON.parse(args.policy);
const object = value => typeof value === 'object' && value !== null && !Array.isArray(value);
if (!object(ledger) || !Array.isArray(ledger.entries) || !ledger.entries.length
  || !Array.isArray(ledger.claimedTotals) || !ledger.entries.every(object)) {
  throw new Error('The reimbursement ledger requires entry objects and a claimedTotals array.');
}
if (!object(policy) || !object(policy.currencyScale) || !object(policy.perItemLimits)
  || !Array.isArray(policy.requiredFields) || !policy.requiredFields.every(field => typeof field === 'string' && field.trim())) {
  throw new Error('The company rules must declare currencyScale, perItemLimits and requiredFields.');
}
const units = (amount, scale) => {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6 || typeof amount !== 'string'
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > scale) return null;
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
};
const decimal = (amount, scale) => {
  const text = amount.toString().padStart(scale + 1, '0');
  return scale === 0 ? text : text.slice(0, -scale) + '.' + text.slice(-scale);
};
phase('Check');
const totals = new Map();
const receipts = new Set();
const ids = new Set();
const findings = [];
const uncheckedRules = [];
if (Object.keys(policy.perItemLimits).length === 0) uncheckedRules.push('No per-item amount limits were supplied.');
for (const [index, row] of ledger.entries.entries()) {
  const entry = index + 1;
  for (const field of policy.requiredFields) {
    if (!Object.hasOwn(row, field) || typeof row[field] !== 'string' || !row[field].trim()) {
      findings.push({ entry, code: 'missing_field', field });
    }
  }
  if (typeof row.id !== 'string' || !row.id.trim()) findings.push({ entry, code: 'missing_entry_id' });
  else if (ids.has(row.id)) findings.push({ entry, code: 'duplicate_entry_id', id: row.id });
  else ids.add(row.id);
  if (typeof row.receipt === 'string' && row.receipt.trim()) {
    if (receipts.has(row.receipt)) findings.push({ entry, code: 'duplicate_receipt', receipt: row.receipt });
    receipts.add(row.receipt);
  }
  if (typeof row.currency !== 'string' || !Object.hasOwn(policy.currencyScale, row.currency)) {
    findings.push({ entry, code: 'unknown_currency' });
    continue;
  }
  const scale = policy.currencyScale[row.currency];
  const amount = units(row.amount, scale);
  if (amount === null) {
    findings.push({ entry, code: 'invalid_amount_or_scale', currency: row.currency });
    continue;
  }
  totals.set(row.currency, (totals.get(row.currency) || 0n) + amount);
  if (Object.hasOwn(policy.perItemLimits, row.currency)) {
    const limit = units(policy.perItemLimits[row.currency], scale);
    if (limit === null) uncheckedRules.push('Invalid amount limit for ' + row.currency + '.');
    else if (amount > limit) findings.push({ entry, code: 'over_item_limit', currency: row.currency,
      amount: decimal(amount, scale), limit: decimal(limit, scale) });
  } else uncheckedRules.push('No per-item amount limit was supplied for ' + row.currency + '.');
}
const claimedCurrencies = new Set();
for (const claim of ledger.claimedTotals) {
  if (!object(claim) || typeof claim.currency !== 'string' || !Object.hasOwn(policy.currencyScale, claim.currency)) {
    findings.push({ code: 'invalid_claimed_total' });
    continue;
  }
  if (claimedCurrencies.has(claim.currency)) findings.push({ code: 'duplicate_claimed_total', currency: claim.currency });
  claimedCurrencies.add(claim.currency);
  const scale = policy.currencyScale[claim.currency];
  const claimed = units(claim.amount, scale);
  if (claimed === null) findings.push({ code: 'invalid_claimed_total', currency: claim.currency });
  else if (claimed !== (totals.get(claim.currency) || 0n)) findings.push({ code: 'claimed_total_mismatch',
    currency: claim.currency, claimed: decimal(claimed, scale), computed: decimal(totals.get(claim.currency) || 0n, scale) });
}
const checks = {
  totals: [...totals].map(([currency, amount]) => ({ currency, amount: decimal(amount, policy.currencyScale[currency]) })),
  findings, uncheckedRules: [...new Set(uncheckedRules)],
  scope: 'Evidence checks only; no reimbursement approval or payment.',
};
phase('Review');
const report = await agent(
  'Review the actual reimbursement ledger and company rules together with the exact arithmetic checks below. '
  + 'Return a report in the source language that preserves every finding, unchecked rule and source limitation. '
  + 'Compare source references and rule applicability; do not invent receipts, amounts, rates or approvals. '
  + 'No finding means only that these checks found none, never that reimbursement was approved. '
  + 'Do not use tools, submit a claim or initiate payment.\n\n' + JSON.stringify({ ledger, policy, checks }),
  { label: 'Review reimbursement evidence' }
);
if (typeof report !== 'string' || !report.trim()) {
  throw new Error('Reimbursement review did not produce a usable report.');
}
return { checks, report };
```

## Deliver and report

After successful review, write a new Markdown report containing both the returned `checks` JSON and the review text, read the saved file to verify it, then `present` its actual path. Keep computed totals and findings exactly as returned, including excluded invalid rows and unknown rules. State the source coverage and any policy or receipt review still needed. Failed or cancelled checks retain their original workflow and tool records; do not deliver partial work as completed. Never submit reimbursement, send the report, create an approval or make a payment as part of this skill.
