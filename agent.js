#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { exec } from "child_process";
import dotenv from "dotenv";
import OpenAI from "openai";
import simpleGit from "simple-git";
import { encode } from "gpt-tokenizer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

// Token counting and compression
const MAX_TOKENS = 6000;
const MAX_MESSAGES = 20;

function countTokens(text) {
  return encode(text).length;
}

function countMessageTokens(message) {
  return countTokens(`${message.role}: ${message.content}`);
}

function totalTokens() {
  return messages.reduce((sum, msg) => sum + countMessageTokens(msg), 0);
}

function compressContext() {
  let tokens = totalTokens();
  if (tokens <= MAX_TOKENS && messages.length <= MAX_MESSAGES) {
    return;
  }
  // Keep system message and the most recent messages
  const system = messages[0];
  const recent = messages.slice(-MAX_MESSAGES + 1); // +1 because we'll add system back
  messages = [system, ...recent];
  // If still over token limit, remove oldest non‑system messages
  while (totalTokens() > MAX_TOKENS && messages.length > 2) {
    messages.splice(1, 1); // remove the oldest after system
  }
  console.log("🔧 Context compressed.");
}

const AUTO_APPROVE = process.env.AUTO_APPROVE === "true";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com"
});

const git = simpleGit();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let messages = [
  {
    role: "system",
    content: `
You are an autonomous coding agent that can execute any shell command, read/write files, and commit changes.

You are working in directory: ${process.cwd()}

When you need to perform an action, respond ONLY in JSON:

Run command: { "action": "run", "command": "..." }
Read file: { "action": "read", "file": "..." }
Apply patch: { "action": "patch", "file": "...", "content": "full new content" }
Commit: { "action": "commit", "message": "..." }

Otherwise respond normally.

Keep responses concise. The context window is limited; if the conversation grows too long, older messages will be compressed.
`
  }
];

function ask(q) {
  return new Promise(res => rl.question(q, res));
}

function runCommand(command) {
  return new Promise(resolve => {
    exec(command, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve(stderr || err.message);
      else resolve(stdout);
    });
  });
}

async function applyPatch(file, content) {
  fs.writeFileSync(file, content);
  return `Patched ${file}`;
}

async function commitChanges(message) {
  await git.add(".");
  await git.commit(message);
  return "Committed changes.";
}

async function processInput(input) {
  if (input === "/exit") process.exit(0);
  if (input === "/reset") {
    messages = [messages[0]];
    console.log("🔄 Context reset.");
    return;
  }
  if (input === "/pwd") {
    console.log(process.cwd());
    return;
  }

  messages.push({ role: "user", content: input });
  compressContext();

  const stream = await client.chat.completions.create({
    model: "deepseek-chat",
    messages,
    stream: false
  });

  const reply = stream.choices[0].message.content;

  let parsed;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = null;
  }

  if (!parsed) {
    console.log("\n🤖 " + reply + "\n");
    messages.push({ role: "assistant", content: reply });
    compressContext();
    return;
  }

  if (parsed.action === "run") {
    if (!AUTO_APPROVE) {
      const confirm = await ask(`⚠ Run "${parsed.command}"? (y/n): `);
      if (confirm !== "y") return;
    }

    const output = await runCommand(parsed.command);
    console.log(output);

    messages.push({
      role: "assistant",
      content: `Command output:\n${output}`
    });
    compressContext();
    return;
  }

  if (parsed.action === "patch") {
    if (!AUTO_APPROVE) {
      const confirm = await ask(`⚠ Patch file "${parsed.file}"? (y/n): `);
      if (confirm !== "y") return;
    }

    const result = await applyPatch(parsed.file, parsed.content);
    console.log(result);

    messages.push({
      role: "assistant",
      content: result
    });
    compressContext();
    return;
  }

  if (parsed.action === "commit") {
    const result = await commitChanges(parsed.message);
    console.log(result);

    messages.push({
      role: "assistant",
      content: result
    });
    compressContext();
    return;
  }
}

async function loop() {
  const input = await ask("> ");
  await processInput(input);
  loop();
}

// Command-line argument handling
const args = process.argv.slice(2);
const interactive = args.includes("--interactive");
const initialInputs = args.filter(arg => arg !== "--interactive").join(" ");

if (initialInputs) {
  (async () => {
    await processInput(initialInputs);
    if (interactive) {
      console.log("🤖 Entering interactive mode...");
      loop();
    } else {
      process.exit(0);
    }
  })();
} else {
  console.log("🤖 DeepSeek Autonomous Agent Ready");
  console.log("Commands: /reset /exit /pwd");
  loop();
}
