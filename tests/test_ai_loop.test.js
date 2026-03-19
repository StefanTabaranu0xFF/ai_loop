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

test('gatherOpenLabContext reads a single file', () => {
  withTempDir((root) => {
    const filePath = path.join(root, 'sample.txt');
    fs.writeFileSync(filePath, 'hello', 'utf8');
    const context = aiLoop.gatherOpenLabContext(filePath, 5);
    assert.match(context, /FILE: sample\.txt/);
    assert.match(context, /hello/);
  });
});

test('gatherOpenLabContext reports omitted directory entries', () => {
  withTempDir((root) => {
    for (let index = 0; index < 3; index += 1) {
      fs.writeFileSync(path.join(root, `file${index}.txt`), String(index), 'utf8');
    }
    const context = aiLoop.gatherOpenLabContext(root, 2);
    assert.match(context, /additional file\(s\) omitted/);
  });
});

test('safeJoin rejects parent escape', () => {
  assert.throws(() => aiLoop.safeJoin('/tmp/workspace', '../evil.txt'), /outside workspace/);
});

test('buildUserPrompt appends feedback', () => {
  const prompt = aiLoop.buildUserPrompt({
    goal: 'Build a parser',
    workspace: '/tmp/workspace',
    buildCommands: ['dotnet build'],
    runCommand: 'dotnet run',
    successSubstring: 'done',
  }, 'FILE: input.txt\nabc', 'compiler error');

  assert.match(prompt, /Build a parser/);
  assert.match(prompt, /compiler error/);
});

test('validateModelResponse rejects invalid payloads', () => {
  assert.throws(() => aiLoop.validateModelResponse({ files: [] }), /non-empty 'files' list/);
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
          files: [{ path: 'Program.cs', content: 'Console.WriteLine("hi");' }],
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
