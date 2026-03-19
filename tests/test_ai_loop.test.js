'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const aiLoop = require('../ai_loop');

function withTempDir(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-'));
  try {
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('gatherOpenLabContext reads a single file and reports inferred metadata', () => {
  withTempDir((root) => {
    const filePath = path.join(root, 'sample.amx');
    fs.writeFileSync(filePath, '<Records><Record><Name>A</Name></Record></Records>', 'utf8');
    const context = aiLoop.gatherOpenLabContext(filePath, 5);
    assert.match(context, /FILE: sample\.amx/);
    assert.match(context, /inferred_format: amx-xml-like/);
    assert.match(context, /candidate_fields: Records, Record, Name/);
  });
});

test('gatherOpenLabContext reports omitted directory entries', () => {
  withTempDir((root) => {
    for (let index = 0; index < 3; index += 1) {
      fs.writeFileSync(path.join(root, `file${index}.txt`), String(index), 'utf8');
    }
    const context = aiLoop.gatherOpenLabContext(root, 2);
    assert.match(context, /Additional files omitted from inline analysis: 1/);
  });
});

test('buildMissingPathMessage includes nearby suggestions when available', () => {
  withTempDir((root) => {
    const previousCwd = process.cwd();
    fs.mkdirSync(path.join(root, 'openlab', 'Methods'), { recursive: true });
    process.chdir(root);
    try {
      const message = aiLoop.buildMissingPathMessage(path.join(root, 'openlab_output'));
      assert.match(message, /OpenLab path does not exist/);
      assert.match(message, /openlab\/Methods/);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('safeJoin rejects parent escape', () => {
  assert.throws(() => aiLoop.safeJoin('/tmp/workspace', '../evil.txt'), /outside workspace/);
});

test('buildUserPrompt appends feedback and analysis guidance', () => {
  const prompt = aiLoop.buildUserPrompt({
    goal: 'Build a parser',
    workspace: '/tmp/workspace',
    buildCommands: ['dotnet build'],
    runCommand: 'dotnet run',
    successSubstring: 'done',
  }, 'FILE: input.txt\n- inferred_format: csv', 'compiler error');

  assert.match(prompt, /Build a parser/);
  assert.match(prompt, /compiler error/);
  assert.match(prompt, /Always include a \.csproj or \.sln/);
});

test('validateModelResponse rejects invalid payloads', () => {
  assert.throws(() => aiLoop.validateModelResponse({ files: [] }), /non-empty 'files' list/);
});

test('ensureBuildableProject reports missing .NET project files', () => {
  withTempDir((root) => {
    fs.writeFileSync(path.join(root, 'Program.cs'), 'Console.WriteLine("hi");', 'utf8');
    const result = aiLoop.ensureBuildableProject({ workspace: root, buildCommands: ['dotnet build'] });
    assert.equal(result.returncode, 1);
    assert.match(result.stdout, /No \.csproj or \.sln file was generated/);
  });
});

test('executeLoop succeeds after validation', async () => {
  await new Promise((resolve, reject) => {
    withTempDir((root) => {
      const logs = [];
      aiLoop.executeLoop({
        goal: 'Say hello',
        model: 'gemma3:12b',
        workspace: root,
        openlabPath: null,
        maxIterations: 1,
        ollamaHost: 'http://127.0.0.1:11434',
        buildCommands: ['dotnet build'],
        runCommand: null,
        successSubstring: null,
        fileLimit: 3,
        dryRun: false,
      }, {
        callOllamaImpl: async () => ({
          summary: 'Created app',
          files: [
            { path: 'App.csproj', content: '<Project Sdk="Microsoft.NET.Sdk"></Project>' },
            { path: 'Program.cs', content: 'Console.WriteLine("hi");' },
          ],
          notes: [],
        }),
        runValidationImpl: () => ({ success: true, results: [] }),
        logger: { log: (message) => logs.push(message), error: (message) => logs.push(message) },
      }).then((code) => {
        try {
          assert.equal(code, 0);
          assert.equal(fs.existsSync(path.join(root, 'Program.cs')), true);
          assert.match(logs.join('\n'), /Goal achieved/);
          resolve();
        } catch (error) {
          reject(error);
        }
      }).catch(reject);
    });
  });
});
