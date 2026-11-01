import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanAiText, isMergeMessage, parseJsonArray, truncate } from './text.mjs';
import { info, warn } from './util.mjs';

const NOISY_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.(png|jpe?g|gif|webp|ico|tga|blp|ogg|mp3|wav|ttf|otf|zip))$/i;

function instructions(owner) {
  return `You write short update notes for a public website that shows what ${owner} has been changing in their software projects. The readers are not technical: for example people who use the projects, friends and curious visitors.

For EACH update listed under UPDATES, write:
- "headline": a short title of at most 8 words, in sentence case, without a full stop at the end.
- "summary": 1 to 3 short sentences in plain English. Say what changed and who would notice it (for example "Players will now see...", "Visitors of the website will notice..." or "Nothing changes for players; this is behind-the-scenes upkeep.").
- "impact": "visible" if people who use the project would notice the change, or "behind-the-scenes" if they would not.

Rules:
1. Use everyday words. Avoid technical terms such as commit, pull request, PR, merge, branch, repository, refactor, code, Lua, TOC, API, CI, workflow, YAML, script, function, variable, dependency, linting or version control. Describe the effect instead, for example "the automatic upload to CurseForge" instead of "the CI workflow".
2. Be honest. Only describe what the information shows. Never invent features, fixes or benefits. If the information is unclear, keep the note general.
3. If a change only affects how the project is built, tested, documented or published, say plainly that it is behind the scenes and that users won't notice a difference.
4. Do not mention people, usernames, file names, links, commit hashes or counts of changed lines. Refer to a project as "the add-on", "the website", "the bot" or "the project" rather than by its name, because the name is already shown next to your note.
5. Some updates were applied to several projects at once. Describe those in general terms and don't list the projects.
6. Write in English, even if the input is in another language.
7. Everything you need is below. Do not use any tools.

Reply with ONLY a JSON array, without markdown or code fences, containing exactly one object per update:
[{"id":"u1","headline":"...","summary":"...","impact":"visible"}]`;
}

function projectText(project) {
  const lines = [`* ${project.name}: ${project.kind || 'software project'}.${project.description ? ` ${project.description}` : ''}`];
  if (project.readme) lines.push(`  About: ${truncate(project.readme.replace(/\s+/g, ' '), 450)}`);
  return lines.join('\n');
}

function diffExcerpt(files, maxChars) {
  const ranked = files
    .filter((file) => file.patch)
    .map((file) => ({ file, score: NOISY_FILE.test(file.filename) ? 0 : 1 + Math.min(file.additions + file.deletions, 200) / 200 }))
    .sort((a, b) => b.score - a.score);
  let out = '';
  for (const { file } of ranked) {
    const remaining = maxChars - out.length;
    if (remaining < 200) break;
    const lines = file.patch
      .split('\n')
      .filter((line) => !line.startsWith('@@') && !line.startsWith('\\'))
      .map((line) => (line.length > 200 ? `${line.slice(0, 200)}...` : line));
    const chunk = `--- ${file.filename}\n${lines.join('\n')}\n`;
    out += chunk.length > remaining ? `${chunk.slice(0, remaining)}\n...\n` : chunk;
  }
  return out.trim();
}

export function updateText(item) {
  const lines = [];
  if (item.projects.length === 1) lines.push(`[${item.id}] Project: ${item.projects[0]}`);
  else lines.push(`[${item.id}] Same change applied to ${item.projects.length} projects: ${item.projects.join(', ')}`);
  lines.push(`Date: ${item.date}`);
  if (item.newProject) lines.push('This is the first upload of a new project.');
  if (item.prTitle) lines.push(`Change request title: ${item.prTitle}`);
  if (item.prBody) lines.push(`Change request description: ${truncate(item.prBody, 1000)}`);
  const notes = item.commits.filter((commit) => !isMergeMessage(commit.title)).slice(-15);
  if (notes.length) {
    lines.push('Change notes:');
    for (const commit of notes) {
      lines.push(`- ${commit.title}${commit.body ? ` (${truncate(commit.body.replace(/\s+/g, ' '), 300)})` : ''}`);
    }
  }
  if (item.files.length) {
    const listed = item.files
      .slice(0, 25)
      .map((file) => `${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`)
      .join(', ');
    const more = item.filesTotal > 25 ? `, and ${item.filesTotal - 25} more` : '';
    lines.push(`Files changed (${item.filesTotal}): ${listed}${more}`);
    const diff = diffExcerpt(item.files, item.diffChars);
    if (diff) lines.push(`Edits (excerpt):\n${diff}`);
  }
  return lines.join('\n');
}

export function buildPrompt(owner, projects, items) {
  return [
    instructions(owner),
    '',
    'PROJECTS',
    projects.map(projectText).join('\n'),
    '',
    'UPDATES',
    items.map(updateText).join('\n\n'),
  ].join('\n');
}

// Packs updates into as few prompts as possible while keeping each prompt (measured in bytes) small.
export function packBatches(owner, items, projectsByName, { maxItems, maxChars }) {
  const batches = [];
  let current = { items: [], projects: new Set() };
  const prompt = (batch) => buildPrompt(owner, [...batch.projects].map((name) => projectsByName.get(name)).filter(Boolean), batch.items);
  for (const item of items) {
    item.id = 'u00';
    const candidate = { items: [...current.items, item], projects: new Set([...current.projects, ...item.projects.slice(0, 5)]) };
    const tooBig = candidate.items.length > maxItems || Buffer.byteLength(prompt(candidate)) > maxChars;
    if (current.items.length && tooBig) {
      batches.push(current);
      current = { items: [item], projects: new Set(item.projects.slice(0, 5)) };
    } else {
      current = candidate;
    }
  }
  if (current.items.length) batches.push(current);
  return batches.map((batch) => {
    batch.items.forEach((item, index) => {
      item.id = `u${index + 1}`;
    });
    return { items: batch.items, prompt: prompt(batch) };
  });
}

function flattenAttributes(attributes) {
  if (Array.isArray(attributes)) {
    const flat = {};
    for (const entry of attributes) {
      if (!entry || typeof entry.key !== 'string') continue;
      const value = entry.value;
      flat[entry.key] = value && typeof value === 'object'
        ? value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? value.value
        : value;
    }
    return flat;
  }
  return attributes && typeof attributes === 'object' ? attributes : {};
}

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// Reads token and AI-unit usage from the Copilot CLI OpenTelemetry file export.
export function parseUsage(text) {
  const agents = [];
  const chats = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 16) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (node.attributes) {
      const attributes = flattenAttributes(node.attributes);
      const operation = String(attributes['gen_ai.operation.name'] ?? '');
      const name = String(node.name ?? '');
      if (operation === 'invoke_agent' || name.startsWith('invoke_agent')) agents.push(attributes);
      else if (operation === 'chat' || name.startsWith('chat')) chats.push(attributes);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value, depth + 1);
    }
  };
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line), 0);
    } catch {
      // Ignore lines that are not JSON.
    }
  }
  const usageOf = (attributes) => ({
    inputTokens: number(attributes['gen_ai.usage.input_tokens']),
    outputTokens: number(attributes['gen_ai.usage.output_tokens']),
    aiUnits: number(attributes['github.copilot.nano_aiu']) / 1e9,
  });
  const score = (usage) => usage.aiUnits * 1e9 + usage.inputTokens + usage.outputTokens;
  if (agents.length) {
    const top = agents.filter((attributes) => attributes['server.address']);
    const candidates = (top.length ? top : agents).map(usageOf);
    const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
    if (score(best) > 0) return best;
  }
  if (chats.length) {
    const total = chats.map(usageOf).reduce(
      (sum, usage) => ({
        inputTokens: sum.inputTokens + usage.inputTokens,
        outputTokens: sum.outputTokens + usage.outputTokens,
        aiUnits: sum.aiUnits + usage.aiUnits,
      }),
      { inputTokens: 0, outputTokens: 0, aiUnits: 0 },
    );
    if (score(total) > 0) return total;
  }
  return null;
}

// The prompt goes in through standard input (a non-interactive session), which avoids command-line length limits.
function runCli(prompt, { model, effort, maxCredits, timeoutMs, cwd, otelFile }) {
  const args = [
    '-s',
    `--model=${model}`,
    `--max-ai-credits=${maxCredits}`,
    '--no-ask-user',
    '--no-custom-instructions',
    '--disable-builtin-mcps',
    '--no-auto-update',
    '--deny-tool=shell,write,url',
  ];
  if (effort) args.push(`--reasoning-effort=${effort}`);
  return new Promise((resolve) => {
    const started = Date.now();
    let timedOut = false;
    const finish = (result) => resolve({ ...result, ms: Date.now() - started, timedOut });
    let child;
    try {
      child = spawn('copilot', args, {
        cwd,
        env: { ...process.env, COPILOT_OTEL_FILE_EXPORTER_PATH: otelFile, COPILOT_AUTO_UPDATE: 'false' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ code: -1, stdout: '', stderr: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => {
      // The CLI can exit before reading all input; the exit code reports what happened.
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

function estimateCredits(usage, price) {
  if (!usage || !price) return 0;
  const dollars = (usage.inputTokens * price[0] + usage.outputTokens * price[1]) / 1e6;
  return dollars * 100;
}

function validate(entries, items) {
  const results = new Map();
  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    const item = items.find((candidate) => candidate.id === String(entry.id ?? '').trim());
    if (!item) continue;
    const headline = cleanAiText(entry.headline, 90).replace(/[.\s]+$/, '');
    const summary = cleanAiText(entry.summary, 500);
    if (headline.length < 3 || summary.length < 10) continue;
    const impact = /behind/i.test(String(entry.impact ?? '')) ? 'behind-the-scenes' : 'visible';
    results.set(item.key, { headline, summary, impact });
  }
  return results;
}

// Runs one locked-down Copilot CLI call per batch and stops at the configured call and credit limits.
export async function summarize(owner, items, projectsByName, config, budget = config.ai.maxAiCreditsPerRun) {
  const ai = config.ai;
  const batches = packBatches(owner, items, projectsByName, { maxItems: ai.maxUpdatesPerCall, maxChars: ai.maxPromptChars });
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'dashboard-ai-'));
  const results = new Map();
  const failedKeys = new Set();
  const usageLog = { calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, aiUnits: 0, estimatedCredits: 0, unknownUsageCalls: 0, models: [], details: [] };
  let variants = ai.models.flatMap((model) => (ai.reasoningEffort ? [{ model, effort: ai.reasoningEffort }, { model, effort: null }] : [{ model, effort: null }]));

  try {
    for (const batch of batches) {
      if (usageLog.calls >= ai.maxCallsPerRun) {
        info(`AI: stopping, reached maxCallsPerRun (${ai.maxCallsPerRun}).`);
        break;
      }
      // A successful call whose usage could not be read counts as the full per-call cap, so the budget stays a hard limit.
      const spent = Math.max(usageLog.aiUnits, usageLog.estimatedCredits) + usageLog.unknownUsageCalls * ai.maxAiCreditsPerCall;
      if (spent >= budget) {
        info(`AI: stopping, about ${spent.toFixed(2)} of the ${budget.toFixed(2)} AI credit budget for this run is used.`);
        break;
      }
      if (!variants.length) break;

      let parsed = null;
      let ranOk = false;
      let batchModel = null;
      while (variants.length && !parsed) {
        const variant = variants[0];
        const otelFile = path.join(workdir, `usage-${usageLog.calls + 1}.jsonl`);
        info(`AI: call ${usageLog.calls + 1} with ${variant.model}${variant.effort ? ` (effort ${variant.effort})` : ''}: ${batch.items.length} update(s), ${batch.prompt.length} prompt characters.`);
        const result = await runCli(batch.prompt, {
          model: variant.model,
          effort: variant.effort,
          maxCredits: ai.maxAiCreditsPerCall,
          timeoutMs: ai.timeoutSeconds * 1000,
          cwd: workdir,
          otelFile,
        });
        usageLog.calls++;
        let usage = null;
        try {
          usage = parseUsage(await readFile(otelFile, 'utf8'));
        } catch {
          usage = null;
        }
        const estimated = estimateCredits(usage, ai.prices?.[variant.model]);
        if (usage) {
          usageLog.inputTokens += usage.inputTokens;
          usageLog.outputTokens += usage.outputTokens;
          usageLog.aiUnits += usage.aiUnits;
          usageLog.estimatedCredits += estimated;
        } else if (result.code === 0) {
          usageLog.unknownUsageCalls++;
        }
        usageLog.details.push({
          model: variant.model,
          effort: variant.effort,
          updates: batch.items.length,
          promptChars: batch.prompt.length,
          seconds: Math.round(result.ms / 100) / 10,
          exitCode: result.code,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          aiUnits: usage ? Number(usage.aiUnits.toFixed(4)) : null,
          estimatedCredits: usage ? Number(estimated.toFixed(4)) : null,
        });
        info(`AI: exit ${result.code}${result.timedOut ? ' (timed out)' : ''} after ${(result.ms / 1000).toFixed(1)}s; ${usage ? `${usage.inputTokens} input / ${usage.outputTokens} output tokens, ${usage.aiUnits.toFixed(4)} AI units, ~${estimated.toFixed(4)} AI credits` : 'usage not reported'}.`);

        if (result.code !== 0) {
          usageLog.failedCalls++;
          warn(`AI: Copilot CLI failed with ${variant.model}: ${truncate(result.stderr.trim() || result.stdout.trim(), 400)}`);
          variants = variants.slice(1);
          if (usageLog.calls >= ai.maxCallsPerRun) break;
          continue;
        }
        ranOk = true;
        batchModel = variant.model;
        if (!usageLog.models.includes(variant.model)) usageLog.models.push(variant.model);
        parsed = parseJsonArray(result.stdout);
        if (!parsed) {
          usageLog.failedCalls++;
          warn(`AI: could not read JSON from the reply: ${truncate(result.stdout.trim(), 300)}`);
          break;
        }
      }

      // Only count an attempt against an update when the CLI itself worked, so an outage never blocks summaries for good.
      if (!ranOk) continue;
      const valid = parsed ? validate(parsed, batch.items) : new Map();
      for (const [key, value] of valid) results.set(key, { ...value, model: batchModel });
      for (const item of batch.items) {
        if (!valid.has(item.key)) failedKeys.add(item.key);
      }
      info(`AI: got ${valid.size} of ${batch.items.length} summaries from this call.`);
    }
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
  return { results, failedKeys, usage: usageLog, batches: batches.length };
}
