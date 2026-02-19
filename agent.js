#!/usr/bin/env node

import fs from "fs";
import path from "path";
import readline from "readline";
import { exec } from "child_process";
import dotenv from "dotenv";
import OpenAI from "openai";
import simpleGit from "simple-git";

dotenv.config();

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
You are an autonomous coding agent.

When needed respond ONLY in JSON:

Run command:
{ "action": "run", "command": "..." }

Read file:
{ "action": "read", "file": "..." }

Apply patch:
{ "action": "patch", "file": "...", "content": "full new content" }

Commit:
{ "action": "commit", "message": "..." }

Otherwise respond normally.
`
  }
];

function ask(q) {
  return new Promise(res => rl.question(q, res));
}

function runCommand(command) {
  const allowed = ["npm", "node", "git", "ls", "cat", "echo", "pwd"];
  if (!allowed.some(cmd => command.startsWith(cmd))) {
    return Promise.resolve("❌ Command not allowed.");
  }

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

async function loop() {
  const input = await ask("> ");

  if (input === "/exit") process.exit(0);
  if (input === "/reset") {
    messages = [messages[0]];
    console.log("🔄 Context reset.");
    return loop();
  }

  messages.push({ role: "user", content: input });

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
    return loop();
  }

  if (parsed.action === "run") {
    if (!AUTO_APPROVE) {
      const confirm = await ask(`⚠ Run "${parsed.command}"? (y/n): `);
      if (confirm !== "y") return loop();
    }

    const output = await runCommand(parsed.command);
    console.log(output);

    messages.push({
      role: "assistant",
      content: `Command output:\n${output}`
    });

    return loop();
  }

  if (parsed.action === "patch") {
    if (!AUTO_APPROVE) {
      const confirm = await ask(`⚠ Patch file "${parsed.file}"? (y/n): `);
      if (confirm !== "y") return loop();
    }

    const result = await applyPatch(parsed.file, parsed.content);
    console.log(result);

    messages.push({
      role: "assistant",
      content: result
    });

    return loop();
  }

  if (parsed.action === "commit") {
    const result = await commitChanges(parsed.message);
    console.log(result);

    messages.push({
      role: "assistant",
      content: result
    });

    return loop();
  }

  loop();
}

console.log("🤖 DeepSeek Autonomous Agent Ready");
console.log("Commands: /reset /exit");
loop();
