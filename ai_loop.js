#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SYSTEM_PROMPT = `You are an autonomous coding agent.
You must produce a complete C# solution that satisfies the user's goal.
Always respond with JSON matching this shape:
{
  "summary": "short description",
  "files": [
    {"path": "relative/path.csproj", "content": "..."},
    {"path": "relative/Program.cs", "content": "..."}
  ],
  "commands": [
    {"command": "dotnet new console --force", "purpose": "scaffold the solution"}
  ],
  "notes": ["optional bullet", "optional bullet"]
}
Rules:
- Either 'files' or 'commands' may be used, but at least one of them must be present and non-empty.
- Commands run inside the workspace and may inspect files, create folders, invoke dotnet, or run local scripts inside the workspace.
- Prefer using an SDK-style .NET project and include a .csproj or .sln.
- Include tests when the goal can be tested.
- When OpenLab files are provided, use the OpenLab analysis below as the source of truth for file formats, likely record structure, and candidate fields.
- If the files are binary or partially unknown, create robust parser code that reports what it can infer and handles unsupported formats gracefully.
- Never use sudo, never depend on interactive prompts, and never assume files exist outside the workspace unless they are shown in the OpenLab analysis.
- Never wrap the final answer in markdown fences unless you are embedding source code inside a file content string.`;

const DEFAULT_BUILD_COMMANDS = ['dotnet build', 'dotnet test --no-build'];
const DEFAULT_RUN_COMMAND = 'dotnet run --no-build';
const MAX_INLINE_CONTENT = 12000;
const MAX_FIELD_SAMPLES = 12;
const MAX_WORKSPACE_FILES = 30;
const DANGEROUS_COMMAND_PATTERNS = [
  /\bsudo\b/i,
  /\bgit\s+push\b/i,
  /\brm\s+-rf\s+\//i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bdd\s+if=/i,
  /(^|\s)mkfs(\s|$)/i,
  /(^|\s)mount(\s|$)/i,
];

function parseArgs(argv) {
  const options = {
    model: 'gemma3:12b',
    workspace: './generated_solution',
    openlabPath: null,
    maxIterations: 3,
    ollamaHost: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    buildCommands: [],
    runCommand: DEFAULT_RUN_COMMAND,
    successSubstring: null,
    fileLimit: 12,
    dryRun: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--model') {
      options.model = argv[++index];
      continue;
    }
    if (arg === '--workspace') {
      options.workspace = argv[++index];
      continue;
    }
    if (arg === '--openlab-path') {
      options.openlabPath = argv[++index];
      continue;
    }
    if (arg === '--max-iterations') {
      options.maxIterations = Number.parseInt(argv[++index], 10);
      continue;
    }
    if (arg === '--ollama-host') {
      options.ollamaHost = argv[++index];
      continue;
    }
    if (arg === '--build-command') {
      options.buildCommands.push(argv[++index]);
      continue;
    }
    if (arg === '--run-command') {
      options.runCommand = argv[++index];
      continue;
    }
    if (arg === '--success-substring') {
      options.successSubstring = argv[++index];
      continue;
    }
    if (arg === '--file-limit') {
      options.fileLimit = Number.parseInt(argv[++index], 10);
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (options.help) {
    return { help: true };
  }

  if (positional.length === 0) {
    throw new Error('A goal argument is required. Wrap the full goal in quotes if it contains spaces.');
  }
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) {
    throw new Error('--max-iterations must be a positive integer.');
  }
  if (!Number.isInteger(options.fileLimit) || options.fileLimit < 1) {
    throw new Error('--file-limit must be a positive integer.');
  }

  return {
    goal: positional.join(' '),
    model: options.model,
    workspace: path.resolve(options.workspace),
    openlabPath: options.openlabPath ? path.resolve(options.openlabPath) : null,
    maxIterations: options.maxIterations,
    ollamaHost: options.ollamaHost.replace(/\/$/, ''),
    buildCommands: options.buildCommands.length > 0 ? options.buildCommands : [...DEFAULT_BUILD_COMMANDS],
    runCommand: options.runCommand && options.runCommand.trim() ? options.runCommand.trim() : null,
    successSubstring: options.successSubstring,
    fileLimit: options.fileLimit,
    dryRun: options.dryRun,
  };
}

function helpText() {
  return `Usage: node ai_loop.js [options] <goal>

Goal-driven loop for generating, building, running, and validating C# code with Ollama.

Example:
  node ai_loop.js \
    "Create a C# console app that reads all .amx files produced by OpenLab and prints the number of records." \
    --openlab-path ./openlab/Methods

The model can both write files and request safe workspace-local bash commands such as dotnet scaffolding or script execution.
The loop also tolerates imperfect model output by normalizing fenced JSON, file maps, command-only plans, and common alternate keys.

Options:
  --model <name>               Ollama model name (default: gemma3:12b)
  --workspace <path>           Directory where generated files are written
  --openlab-path <path>        OpenLab directory or file to analyze and inline into the prompt
  --max-iterations <n>         Maximum repair iterations (default: 3)
  --ollama-host <url>          Base URL for Ollama (default: http://127.0.0.1:11434)
  --build-command <command>    Build/test command; repeat for multiple steps
  --run-command <command>      Run command after build/test; use empty string to skip
  --success-substring <text>   Require runtime output to contain this text
  --file-limit <n>             Maximum OpenLab files to inline (default: 12)
  --dry-run                    Print the constructed prompt and exit
  -h, --help                   Show this help text`;
}

function gatherOpenLabContext(openlabPath, limit) {
  if (!openlabPath) {
    return 'No OpenLab files were provided.';
  }

  if (!fs.existsSync(openlabPath)) {
    throw new Error(buildMissingPathMessage(openlabPath));
  }

  const stat = fs.statSync(openlabPath);
  const files = stat.isFile()
    ? [openlabPath]
    : walkFiles(openlabPath).sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    return `OpenLab path exists but contains no files: ${openlabPath}`;
  }

  const basePath = stat.isFile() ? path.dirname(openlabPath) : openlabPath;
  const inspected = files.slice(0, limit).map((filePath) => analyzeOpenLabFile(filePath, basePath));
  const extensionCounts = summarizeExtensions(files);
  const suffix = files.length > limit ? `\nAdditional files omitted from inline analysis: ${files.length - limit}` : '';

  return [
    `OpenLab source: ${openlabPath}`,
    `Discovered files: ${files.length}`,
    `Extension summary: ${extensionCounts || 'none'}`,
    '',
    ...inspected.map(formatAnalyzedFile),
    suffix,
  ].filter(Boolean).join('\n');
}

function buildMissingPathMessage(openlabPath) {
  const cwd = process.cwd();
  const searchRoot = fs.existsSync(cwd) ? cwd : path.dirname(openlabPath);
  const suggestions = findNearbyPaths(searchRoot, 12)
    .filter((candidate) => candidate.toLowerCase().includes('openlab') || candidate.toLowerCase().includes('method'))
    .slice(0, 5);

  const suggestionText = suggestions.length > 0
    ? ` Closest matching paths from ${searchRoot}: ${suggestions.map((entry) => path.relative(cwd, entry) || '.').join(', ')}`
    : '';

  return `OpenLab path does not exist: ${openlabPath}.${suggestionText}`;
}

function findNearbyPaths(root, maxResults) {
  const queue = [root];
  const results = [];
  while (queue.length > 0 && results.length < maxResults) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      results.push(resolved);
      if (results.length >= maxResults) {
        break;
      }
      if (entry.isDirectory()) {
        queue.push(resolved);
      }
    }
  }
  return results;
}

function walkFiles(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(resolved);
    }
    return entry.isFile() ? [resolved] : [];
  });
}

function describeWorkspace(workspace) {
  if (!fs.existsSync(workspace)) {
    return `Workspace does not exist yet: ${workspace}`;
  }

  const files = walkFiles(workspace)
    .filter((filePath) => !filePath.includes(`${path.sep}.ai_loop${path.sep}`))
    .map((filePath) => path.relative(workspace, filePath))
    .slice(0, MAX_WORKSPACE_FILES);

  return [
    `Workspace: ${workspace}`,
    `Visible files: ${files.length}`,
    ...files,
  ].join('\n');
}

function analyzeOpenLabFile(filePath, basePath) {
  const buffer = fs.readFileSync(filePath);
  const textLike = isProbablyText(buffer);
  const rawText = textLike ? buffer.toString('utf8') : null;
  const preview = textLike ? rawText.slice(0, MAX_INLINE_CONTENT) : toHexPreview(buffer);
  const format = inferFileFormat(filePath, rawText, buffer);
  const fields = inferCandidateFields(rawText, format);
  const recordEstimate = inferRecordEstimate(rawText, format);

  return {
    path: path.relative(basePath, filePath),
    extension: path.extname(filePath) || '<none>',
    sizeBytes: buffer.length,
    format,
    textLike,
    recordEstimate,
    candidateFields: fields.slice(0, MAX_FIELD_SAMPLES),
    preview,
  };
}

function summarizeExtensions(files) {
  const counts = new Map();
  for (const filePath of files) {
    const extension = path.extname(filePath) || '<none>';
    counts.set(extension, (counts.get(extension) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([extension, count]) => `${extension}:${count}`)
    .join(', ');
}

function formatAnalyzedFile(file) {
  return [
    `FILE: ${file.path}`,
    `- extension: ${file.extension}`,
    `- size_bytes: ${file.sizeBytes}`,
    `- inferred_format: ${file.format}`,
    `- text_like: ${file.textLike}`,
    `- record_estimate: ${file.recordEstimate ?? 'unknown'}`,
    `- candidate_fields: ${file.candidateFields.length > 0 ? file.candidateFields.join(', ') : 'none inferred'}`,
    'PREVIEW:',
    file.preview || '<empty>',
    '',
  ].join('\n');
}

function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
  }
  return true;
}

function inferFileFormat(filePath, rawText, buffer) {
  const extension = path.extname(filePath).toLowerCase();
  const trimmed = rawText ? rawText.trim() : '';

  if (!rawText) {
    if (extension === '.amx') {
      return 'amx-binary-or-unknown';
    }
    return 'binary';
  }
  if (trimmed.startsWith('<')) {
    return extension === '.amx' ? 'amx-xml-like' : 'xml';
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }
  if (looksLikeDelimited(trimmed, ',')) {
    return 'csv';
  }
  if (looksLikeDelimited(trimmed, '\t')) {
    return 'tsv';
  }
  if (/^[A-Za-z0-9_.-]+\s*=\s*.+$/m.test(trimmed)) {
    return 'key-value-text';
  }
  if (extension === '.amx') {
    return 'amx-text-or-unknown';
  }
  if (buffer.length === 0) {
    return 'empty';
  }
  return 'plain-text';
}

function looksLikeDelimited(text, delimiter) {
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 5);
  if (lines.length < 2) {
    return false;
  }
  const counts = lines.map((line) => line.split(delimiter).length);
  return counts.every((count) => count > 1) && new Set(counts).size <= 2;
}

function inferCandidateFields(rawText, format) {
  if (!rawText) {
    return [];
  }
  const trimmed = rawText.trim();

  if (format === 'json') {
    try {
      const parsed = JSON.parse(trimmed);
      const source = Array.isArray(parsed) ? parsed[0] : parsed;
      if (source && typeof source === 'object' && !Array.isArray(source)) {
        return Object.keys(source);
      }
    } catch {
      return [];
    }
  }

  if (format === 'csv' || format === 'tsv') {
    const delimiter = format === 'csv' ? ',' : '\t';
    const firstLine = trimmed.split(/\r?\n/).find(Boolean);
    return firstLine ? firstLine.split(delimiter).map((part) => part.trim()).filter(Boolean) : [];
  }

  if (format === 'xml' || format === 'amx-xml-like') {
    const matches = [...trimmed.matchAll(/<([A-Za-z_][A-Za-z0-9_.:-]*)\b/g)].map((match) => match[1]);
    return [...new Set(matches)].slice(0, MAX_FIELD_SAMPLES);
  }

  const kvMatches = [...trimmed.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*.+$/gm)].map((match) => match[1]);
  if (kvMatches.length > 0) {
    return [...new Set(kvMatches)].slice(0, MAX_FIELD_SAMPLES);
  }

  return [...new Set([...trimmed.matchAll(/\b[A-Za-z][A-Za-z0-9_]{2,}\b/g)].map((match) => match[0]))].slice(0, MAX_FIELD_SAMPLES);
}

function inferRecordEstimate(rawText, format) {
  if (!rawText) {
    return null;
  }
  const trimmed = rawText.trim();
  if (!trimmed) {
    return 0;
  }

  if (format === 'json') {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.length;
      }
      if (parsed && typeof parsed === 'object') {
        return Object.keys(parsed).length;
      }
    } catch {
      return null;
    }
  }

  if (format === 'csv' || format === 'tsv') {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    return Math.max(lines.length - 1, 0);
  }

  if (format === 'xml' || format === 'amx-xml-like') {
    const root = trimmed.match(/^<([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>/);
    const tags = [...trimmed.matchAll(/<([A-Za-z_][A-Za-z0-9_.:-]*)\b/g)].map((match) => match[1]);
    const frequencies = new Map();
    for (const tag of tags) {
      if (tag !== root?.[1]) {
        frequencies.set(tag, (frequencies.get(tag) || 0) + 1);
      }
    }
    const values = [...frequencies.values()].sort((a, b) => b - a);
    return values[0] || null;
  }

  return trimmed.split(/\r?\n/).filter(Boolean).length;
}

function toHexPreview(buffer) {
  return [...buffer.subarray(0, 64)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
}

function buildUserPrompt(config, openlabContext, workspaceContext, feedback) {
  const prompt = [
    'Goal:',
    config.goal,
    '',
    'Constraints:',
    `- Target workspace: ${config.workspace}`,
    `- Produce a C# project that can be built with these commands: ${JSON.stringify(config.buildCommands)}`,
    `- Run command after build/test: ${config.runCommand || 'skip'}`,
    `- Success substring requirement: ${config.successSubstring || 'none'}`,
    '- Always include a .csproj or .sln and any code needed to parse the discovered OpenLab file formats.',
    '- You may request safe workspace-local bash commands to scaffold, inspect, or transform files before validation.',
    '- If you already have enough information to scaffold via commands, a command-only response is acceptable.',
    '- Use the OpenLab analysis below to infer likely record layout, candidate fields, and whether the file is text, XML-like, JSON, delimited, or binary.',
    '',
    'Workspace state:',
    workspaceContext,
    '',
    'OpenLab analysis:',
    openlabContext,
  ].join('\n');

  return feedback ? `${prompt}\n\nPrevious execution feedback:\n${feedback.trim()}` : prompt;
}

async function callOllama(host, model, prompt) {
  let response;
  try {
    response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch (error) {
    throw new Error(`Failed to contact Ollama at ${host}: ${error.message}. Make sure Ollama is running and the model is available.`);
  }

  if (!response.ok) {
    throw new Error(`Failed to contact Ollama at ${host}: ${response.status} ${response.statusText}`);
  }

  const raw = await response.json();
  const content = raw?.message?.content;
  if (!content) {
    throw new Error(`Ollama response did not include message content: ${JSON.stringify(raw)}`);
  }

  return parseAndNormalizeModelResponse(content);
}

function parseAndNormalizeModelResponse(content) {
  const candidates = [content, extractJsonCandidate(content)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return normalizeModelResponse(parsed, content);
    } catch {
      // Keep trying alternate candidates.
    }
  }
  throw new Error(`Model response was not valid JSON. Raw response starts with: ${content.slice(0, 400)}`);
}

function extractJsonCandidate(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return content.slice(start, end + 1);
  }

  return null;
}

function normalizeCommandSpec(commandSpec) {
  if (typeof commandSpec === 'string') {
    return { command: commandSpec, purpose: 'model-requested workspace command' };
  }
  return commandSpec;
}

function coerceFiles(rawFiles) {
  if (!rawFiles) {
    return [];
  }
  if (Array.isArray(rawFiles)) {
    return rawFiles
      .map((item) => {
        if (typeof item === 'string') {
          return null;
        }
        return {
          path: item.path || item.filename || item.file || item.name,
          content: item.content || item.contents || item.text || item.body,
        };
      })
      .filter((item) => item && typeof item.path === 'string' && typeof item.content === 'string');
  }
  if (typeof rawFiles === 'object') {
    return Object.entries(rawFiles)
      .filter(([, value]) => typeof value === 'string')
      .map(([filePath, content]) => ({ path: filePath, content }));
  }
  return [];
}

function coerceCommands(rawCommands) {
  if (!rawCommands) {
    return [];
  }
  if (Array.isArray(rawCommands)) {
    return rawCommands.map(normalizeCommandSpec).filter((item) => item && typeof item.command === 'string');
  }
  if (typeof rawCommands === 'string') {
    return [normalizeCommandSpec(rawCommands)];
  }
  return [];
}

function normalizeModelResponse(payload, originalContent = '') {
  const files = coerceFiles(
    payload.files
    || payload.file
    || payload.write_files
    || payload.artifacts
    || payload.project_files
    || payload.output_files
    || payload.project?.files,
  );

  const commands = coerceCommands(
    payload.commands
    || payload.command
    || payload.shell_commands
    || payload.bash
    || payload.steps,
  );

  const normalized = {
    summary: payload.summary || payload.title || payload.plan || 'model response',
    files,
    commands,
    notes: Array.isArray(payload.notes) ? payload.notes : [],
    rawContentPreview: originalContent.slice(0, 400),
  };

  validateModelResponse(normalized);
  return normalized;
}

function validateModelResponse(payload) {
  const hasFiles = Array.isArray(payload.files) && payload.files.length > 0;
  const hasCommands = Array.isArray(payload.commands) && payload.commands.length > 0;
  if (!payload || (!hasFiles && !hasCommands)) {
    throw new Error("Model response must include at least one file or command. The raw model output could not be normalized into the expected schema.");
  }

  for (const item of payload.files || []) {
    if (!item || typeof item !== 'object') {
      throw new Error('Each files entry must be an object.');
    }
    if (typeof item.path !== 'string' || typeof item.content !== 'string') {
      throw new Error("Each file entry must include string 'path' and 'content'.");
    }
  }

  if (payload.commands !== undefined) {
    if (!Array.isArray(payload.commands)) {
      throw new Error("'commands' must be an array when provided.");
    }
    for (const commandSpec of payload.commands) {
      const normalized = normalizeCommandSpec(commandSpec);
      if (!normalized || typeof normalized.command !== 'string') {
        throw new Error("Each command entry must provide a string 'command'.");
      }
    }
  }
}

function safeJoin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside workspace: ${relativePath}`);
  }
  return candidate;
}

function writeFiles(root, files = []) {
  fs.mkdirSync(root, { recursive: true });
  return files.map((entry) => {
    const destination = safeJoin(root, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.content, 'utf8');
    return destination;
  });
}

function findProjectFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  return walkFiles(root).filter((filePath) => ['.csproj', '.sln'].includes(path.extname(filePath).toLowerCase()));
}

function makeResult(command, returncode, stdout, stderr) {
  return {
    command,
    returncode,
    stdout,
    stderr,
    combinedOutput() {
      return [this.stdout.trim(), this.stderr.trim()].filter(Boolean).join('\n');
    },
  };
}

function validateWorkspaceCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('Command must be a non-empty string.');
  }
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`Refusing dangerous command: ${command}`);
    }
  }
  if (/\.\.\//.test(command)) {
    throw new Error(`Refusing command that navigates outside the workspace: ${command}`);
  }
}

function executeCommand(command, cwd) {
  validateWorkspaceCommand(command);
  const completed = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
  });

  return makeResult(
    command,
    completed.status ?? 1,
    completed.stdout || '',
    completed.stderr || (completed.error ? String(completed.error) : ''),
  );
}

function runModelCommands(config, commands = []) {
  const results = [];
  for (const rawCommandSpec of commands) {
    const commandSpec = normalizeCommandSpec(rawCommandSpec);
    const prefix = commandSpec.purpose ? `# ${commandSpec.purpose}\n` : '';
    try {
      const result = executeCommand(commandSpec.command, config.workspace);
      results.push(makeResult(`model-command: ${commandSpec.command}`, result.returncode, `${prefix}${result.stdout}`, result.stderr));
      if (result.returncode !== 0) {
        return { success: false, results };
      }
    } catch (error) {
      results.push(makeResult(`model-command: ${commandSpec.command}`, 1, prefix, error.message));
      return { success: false, results };
    }
  }
  return { success: true, results };
}

function ensureBuildableProject(config) {
  const projectFiles = findProjectFiles(config.workspace);
  if (projectFiles.length > 0) {
    return null;
  }

  const workspaceFiles = fs.existsSync(config.workspace)
    ? walkFiles(config.workspace).map((filePath) => path.relative(config.workspace, filePath)).slice(0, 20)
    : [];

  return makeResult(
    'project-structure-check',
    1,
    'No .csproj or .sln file was generated.',
    `The workspace must contain a buildable .NET project before running ${config.buildCommands.join(', ')}. Current files: ${workspaceFiles.join(', ') || '<empty workspace>'}`,
  );
}

function runCommand(command, cwd) {
  return executeCommand(command, cwd);
}

function runValidation(config) {
  const structureFailure = ensureBuildableProject(config);
  if (structureFailure) {
    return { success: false, results: [structureFailure] };
  }

  const results = [];
  for (const command of config.buildCommands) {
    const result = runCommand(command, config.workspace);
    results.push(result);
    if (result.returncode !== 0) {
      return { success: false, results };
    }
  }

  if (config.runCommand) {
    const result = runCommand(config.runCommand, config.workspace);
    results.push(result);
    if (result.returncode !== 0) {
      return { success: false, results };
    }
    if (config.successSubstring && !result.combinedOutput().includes(config.successSubstring)) {
      return {
        success: false,
        results: [
          ...results,
          makeResult(
            'success-substring-check',
            1,
            result.combinedOutput(),
            `Expected runtime output to contain substring: ${config.successSubstring}`,
          ),
        ],
      };
    }
  }

  return { success: true, results };
}

function formatResults(results) {
  return results.map((result) => [
    `COMMAND: ${result.command}`,
    `EXIT CODE: ${result.returncode}`,
    'STDOUT:',
    result.stdout.trim() || '<empty>',
    'STDERR:',
    result.stderr.trim() || '<empty>',
  ].join('\n')).join('\n\n');
}

function saveArtifacts(config, prompt, response, results) {
  const metaDir = path.join(config.workspace, '.ai_loop');
  fs.mkdirSync(metaDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(metaDir, `prompt-${timestamp}.txt`), prompt, 'utf8');
  fs.writeFileSync(path.join(metaDir, `response-${timestamp}.json`), JSON.stringify(response, null, 2), 'utf8');
  if (results.length > 0) {
    fs.writeFileSync(path.join(metaDir, `results-${timestamp}.txt`), formatResults(results), 'utf8');
  }
}

async function executeLoop(config, dependencies = {}) {
  const {
    gatherOpenLabContextImpl = gatherOpenLabContext,
    describeWorkspaceImpl = describeWorkspace,
    buildUserPromptImpl = buildUserPrompt,
    callOllamaImpl = callOllama,
    writeFilesImpl = writeFiles,
    runModelCommandsImpl = runModelCommands,
    runValidationImpl = runValidation,
    saveArtifactsImpl = saveArtifacts,
    logger = console,
  } = dependencies;

  const openlabContext = gatherOpenLabContextImpl(config.openlabPath, config.fileLimit);
  let feedback = null;

  if (config.dryRun) {
    const workspaceContext = describeWorkspaceImpl(config.workspace);
    logger.log(buildUserPromptImpl(config, openlabContext, workspaceContext, feedback));
    return 0;
  }

  for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    const workspaceContext = describeWorkspaceImpl(config.workspace);
    const prompt = buildUserPromptImpl(config, openlabContext, workspaceContext, feedback);
    const response = await callOllamaImpl(config.ollamaHost, config.model, prompt);
    writeFilesImpl(config.workspace, response.files || []);

    const commandRun = runModelCommandsImpl(config, response.commands || []);
    const validationRun = commandRun.success ? runValidationImpl(config) : { success: false, results: [] };
    const combinedResults = [...commandRun.results, ...validationRun.results];
    const success = commandRun.success && validationRun.success;

    saveArtifactsImpl(config, prompt, response, combinedResults);

    logger.log(`Iteration ${iteration}/${config.maxIterations}: ${response.summary || 'no summary'}`);
    logger.log(combinedResults.length > 0 ? formatResults(combinedResults) : 'No commands were executed.');

    if (success) {
      logger.log('Goal achieved.');
      return 0;
    }

    feedback = [
      'The previous attempt did not meet the goal. Return a corrected .NET solution with all required project files, file contents, and any workspace-local commands needed to prepare the project.',
      'If you prefer to scaffold with commands first, return a valid command-only plan and then ensure the workspace contains a .csproj or .sln before validation.',
      'Pay special attention to the OpenLab analysis and the workspace state when choosing how to parse the source files and scaffold the solution.',
      '',
      formatResults(combinedResults),
    ].join('\n');
  }

  logger.error('Maximum iterations reached without satisfying the goal.');
  return 1;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      console.log(helpText());
      return 0;
    }
    return await executeLoop(parsed);
  } catch (error) {
    console.error(`ai_loop failed: ${error.message}`);
    return 1;
  }
}

module.exports = {
  DEFAULT_BUILD_COMMANDS,
  DEFAULT_RUN_COMMAND,
  SYSTEM_PROMPT,
  analyzeOpenLabFile,
  buildMissingPathMessage,
  buildUserPrompt,
  callOllama,
  coerceCommands,
  coerceFiles,
  describeWorkspace,
  ensureBuildableProject,
  executeCommand,
  executeLoop,
  extractJsonCandidate,
  findNearbyPaths,
  findProjectFiles,
  formatAnalyzedFile,
  formatResults,
  gatherOpenLabContext,
  helpText,
  inferCandidateFields,
  inferFileFormat,
  inferRecordEstimate,
  isProbablyText,
  looksLikeDelimited,
  makeResult,
  normalizeCommandSpec,
  normalizeModelResponse,
  parseAndNormalizeModelResponse,
  parseArgs,
  runCommand,
  runModelCommands,
  runValidation,
  safeJoin,
  saveArtifacts,
  summarizeExtensions,
  toHexPreview,
  validateModelResponse,
  validateWorkspaceCommand,
  walkFiles,
  writeFiles,
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
