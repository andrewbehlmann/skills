export const meta = {
  name: 'review-with-chaired-debate',
  description: 'Branch review: independent lens reviewers, dedupe, cross-check, chaired 2-round debate on contested findings',
  phases: [
    { title: 'Review', detail: 'independent lens reviewers' },
    { title: 'Merge', detail: 'dedupe across reviewers' },
    { title: 'Cross-check', detail: 'a second lens checks each single-source finding' },
    { title: 'Debate', detail: 'chaired 2-round evidence debate on contested findings' },
  ],
}

// args: { worktree, base, what, spec, tests?, standards?, lenses?, checkerOf? } (see SKILL.md, "Inputs").
const WT = args.worktree
const BASE = args.base ?? 'origin/main'
const TESTS = args.tests
  ? `You may run targeted tests or read-only queries: ${args.tests}`
  : 'Run nothing that writes: no migrations, no database resets, no live third-party calls.'
const CONTEXT = `You are reviewing ${args.what}. Review only: do NOT edit, commit, stash, reset or push anything.
Code: the git worktree ${WT}. The change under review: \`git -C ${WT} diff ${BASE}...HEAD\` (commits: \`git -C ${WT} log --oneline ${BASE}..HEAD\`).
What it was meant to do (binding): ${args.spec}.
Standards: the worktree's CLAUDE.md / AGENTS.md and the docs they point to${args.standards ? `, plus ${args.standards}` : ''}.
${TESTS} Never open .env files or print secrets.
Internal inconsistency and duplication (one rule written twice, the same concept done two ways) rank as the worst defects.`

const DEFAULT_LENSES = [
  { key: 'correctness', focus: 'correctness and concurrency: wrong results, races (two users, retries, background jobs against requests), idempotency, failure paths (a dependency down, partial writes), state left half-done, and behavior that differs from the spec.' },
  { key: 'security', focus: 'security and access: ids from requests belonging to the caller, role checks on the server, untrusted input, secrets and personal data never logged or in URLs, data leaking across tenants or users, public endpoints and their limits.' },
  { key: 'tests', focus: 'tests and failure modes: each owned rule tested through its interface, the failing case covered, tests that test past the interface or duplicate others, and edge cases the change creates (empty, zero, maximum, time zones, ordering).' },
  { key: 'standards', focus: 'standards, consistency and duplication: the same concept done two ways, parallel helpers where one should be reused, docs that contradict the code, repo rules from CLAUDE.md / AGENTS.md, migrations safe while the previous version serves.' },
]
const LENSES = args.lenses ?? DEFAULT_LENSES
// Each lens's single-source findings are checked by another lens: the given map, else the next lens in the list.
const checkerOf = (key) => {
  const named = args.checkerOf?.[key]
  if (named && LENSES.some((l) => l.key === named)) return LENSES.find((l) => l.key === named)
  const i = LENSES.findIndex((l) => l.key === key)
  return LENSES[(i + 1) % LENSES.length]
}
const SEVERITIES = ['critical', 'high', 'medium', 'low']

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: SEVERITIES },
          verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE'] },
          defect: { type: 'string' },
          scenario: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'file', 'severity', 'verdict', 'defect', 'scenario', 'evidence', 'fix'],
      },
    },
    sound: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'sound'],
}

phase('Review')
const reviews = await parallel(LENSES.map((l) => () =>
  agent(`${CONTEXT}

Your lens: ${l.focus}
Stay in your lens, but report anything serious you trip over. Verify every finding by reading the code (trace the path; run a targeted test when it settles a question). Mark CONFIRMED only when you traced it; PLAUSIBLE when likely but unproven. Drop anything you cannot support with file:line evidence. Also list, in \`sound\`, the specific things in your lens you checked and found correct (this tells the lead what was covered). At most 25 findings, most severe first.`,
    { label: `review:${l.key}`, phase: 'Review', schema: FINDINGS })
    .then((r) => ({ lens: l.key, ...(r ?? { findings: [], sound: [] }) }))))

const done = reviews.filter(Boolean)
const all = done.flatMap((r) => r.findings.map((f) => ({ ...f, lens: r.lens })))
log(`${all.length} raw findings from ${done.length} of ${LENSES.length} reviewers`)
const sound = done.map((r) => ({ lens: r.lens, sound: r.sound }))
if (all.length === 0) return { sound, accepted: [], debated: [] }

phase('Merge')
const MERGED = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: SEVERITIES },
          lenses: { type: 'array', items: { type: 'string' } },
          anyConfirmed: { type: 'boolean' },
          defect: { type: 'string' },
          scenario: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['id', 'title', 'file', 'severity', 'lenses', 'anyConfirmed', 'defect', 'scenario', 'evidence', 'fix'],
      },
    },
  },
  required: ['items'],
}
const merged = await agent(`Merge these code-review findings from ${done.length} independent reviewers into one deduplicated list. Two findings are the same when they describe the same defect (same root cause), even if worded differently or pointing at different lines of the same path. For each merged item: a short id (F1, F2, ...), the clearest title, the most precise file/line, the highest severity given, every lens that raised it (\`lenses\`), anyConfirmed (true if any source marked it CONFIRMED), and the best defect/scenario/evidence/fix text (combine evidence from all sources). Drop nothing, invent nothing, judge nothing.

Findings (JSON):
${JSON.stringify(all)}`, { label: 'merge', phase: 'Merge', schema: MERGED, effort: 'low' })
const items = merged?.items ?? []
log(`${items.length} distinct findings after merge`)

// Raised independently by 2+ lenses: accepted without a cross-check.
const multi = items.filter((i) => i.lenses.length >= 2)
const single = items.filter((i) => i.lenses.length < 2)

phase('Cross-check')
const CHECKS = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          position: { type: 'string', enum: ['agree', 'disagree', 'downgrade'] },
          severity: { type: 'string', enum: SEVERITIES },
          evidence: { type: 'string' },
        },
        required: ['id', 'position', 'severity', 'evidence'],
      },
    },
  },
  required: ['checks'],
}
const groups = LENSES.map((l) => ({ lens: l.key, items: single.filter((i) => i.lenses[0] === l.key) })).filter((g) => g.items.length)
const checkedGroups = await parallel(groups.map((g) => () => {
  const checker = checkerOf(g.lens)
  return agent(`${CONTEXT}

Another reviewer (lens: ${g.lens}) reported the findings below. Check EACH one independently against the code. Your lens for judging them: ${checker.focus}

For each id answer \`agree\` (real at about that severity), \`downgrade\` (real but much less severe: give your severity), or \`disagree\` (not a defect: the code handles it, the scenario can't happen, or it contradicts a binding decision in the spec). Evidence must cite file:line or a test you ran; argument alone doesn't count. At most 120 words per finding. Answer every id.

Findings (JSON):
${JSON.stringify(g.items.map(({ id, title, file, line, severity, defect, scenario, evidence }) => ({ id, title, file, line, severity, defect, scenario, evidence })))}`,
    { label: `check:${g.lens}`, phase: 'Cross-check', schema: CHECKS })
}))
const byId = new Map(checkedGroups.filter(Boolean).flatMap((r) => r.checks).map((c) => [c.id, c]))
const checked = single.map((i) => ({ ...i, check: byId.get(i.id) ?? null }))

// Contested: the checker disagrees, gives no answer, or rates it two or more severities lower.
const settled = []
const contested = []
for (const c of checked) {
  const gap = c.check ? Math.abs(SEVERITIES.indexOf(c.check.severity) - SEVERITIES.indexOf(c.severity)) : 0
  if (!c.check || c.check.position === 'disagree' || (c.check.position === 'downgrade' && gap >= 2)) contested.push(c)
  else settled.push(c)
}
log(`${multi.length} raised by several lenses, ${settled.length} single-source agreed, ${contested.length} contested -> debate`)

phase('Debate')
const TURN = { type: 'object', properties: { argument: { type: 'string' } }, required: ['argument'] }
const RULING = {
  type: 'object',
  properties: {
    ruling: { type: 'string', enum: ['confirmed', 'rejected', 'owners_call'] },
    severity: { type: 'string', enum: SEVERITIES },
    reasoning: { type: 'string' },
    fix: { type: 'string' },
    safest_default: { type: 'string' },
  },
  required: ['ruling', 'severity', 'reasoning', 'fix', 'safest_default'],
}
const RULES = 'Debate rules: evidence beats argument. Every claim cites file:line, a traced code path, or a test you ran. Answer the other side\'s strongest point. At most 200 words.'
const debated = await pipeline(contested, async (c) => {
  const brief = `Finding ${c.id}: ${c.title}\nWhere: ${c.file}${c.line ? ':' + c.line : ''}\nDefect: ${c.defect}\nScenario: ${c.scenario}\nReporter's evidence: ${c.evidence}\nReporter's severity: ${c.severity}\nChecker's position: ${c.check?.position ?? 'none'} (${c.check?.severity ?? '-'}): ${c.check?.evidence ?? '(the checker gave no answer)'}`
  const [p1, o1] = await Promise.all([
    agent(`${CONTEXT}\n\nYou argue that this finding IS a real defect at the reporter's severity. Round 1 of 2: state the case.\n${RULES}\n\n${brief}`, { label: `debate:${c.id}:for:1`, phase: 'Debate', schema: TURN }),
    agent(`${CONTEXT}\n\nYou argue that this finding is NOT a defect (or is much less severe). Round 1 of 2: state the case.\n${RULES}\n\n${brief}`, { label: `debate:${c.id}:against:1`, phase: 'Debate', schema: TURN }),
  ])
  const [p2, o2] = await Promise.all([
    agent(`${CONTEXT}\n\nYou argue the finding IS real. Round 2 of 2: answer the other side.\n${RULES}\n\n${brief}\n\nYour round 1: ${p1?.argument}\nTheir round 1: ${o1?.argument}`, { label: `debate:${c.id}:for:2`, phase: 'Debate', schema: TURN }),
    agent(`${CONTEXT}\n\nYou argue the finding is NOT real (or much less severe). Round 2 of 2: answer the other side.\n${RULES}\n\n${brief}\n\nYour round 1: ${o1?.argument}\nTheir round 1: ${p1?.argument}`, { label: `debate:${c.id}:against:2`, phase: 'Debate', schema: TURN }),
  ])
  const ruling = await agent(`${CONTEXT}

You chair a review debate. Rule on the evidence, not on who argued more confidently: verify the decisive claims in the code yourself. Rulings: \`confirmed\` (a real defect; give its severity and the fix), \`rejected\` (not a defect), or \`owners_call\` (only for a genuine product choice the spec doesn't settle; give the safest reversible default in \`safest_default\`: it will be built now and flagged to the owner). For confirmed or rejected, set safest_default to "".

${brief}

FOR, round 1: ${p1?.argument}
AGAINST, round 1: ${o1?.argument}
FOR, round 2: ${p2?.argument}
AGAINST, round 2: ${o2?.argument}`, { label: `chair:${c.id}`, phase: 'Debate', schema: RULING, effort: 'high' })
  return { ...c, debate: { p1: p1?.argument, o1: o1?.argument, p2: p2?.argument, o2: o2?.argument }, ruling }
})

return {
  sound,
  accepted: [...multi.map((i) => ({ ...i, route: 'multi-lens' })), ...settled.map((i) => ({ ...i, route: 'cross-checked' }))],
  debated: debated.filter(Boolean),
}
