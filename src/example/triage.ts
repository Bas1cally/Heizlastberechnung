/**
 * Worked example: triage one inbound support message.
 *
 * All four questions are independent judgments over the same state, so they go
 * out in one request and are judged in parallel. Add a second request only
 * when an answer is needed to fetch new evidence or decide the next options.
 *
 *   npm run triage -- --dry-run   prints the request without sending it
 *   npm run triage                sends it (needs TYPESAFE_API_KEY)
 */

import {
  APIConnectionError,
  APIError,
  TypeSafeClient,
  TypeSafeError,
  band,
  choice,
  nearestLevel,
  noul,
  score,
} from "../index.js";
import { loadEnvFile } from "../typesafe/env.js";

loadEnvFile();

const state = {
  channel: "email",
  waiting_days: 3,
  replies_from_us: 0,
  message: "My payouts have failed for three days and nobody has replied.",
};

const questions = {
  is_urgent: noul(
    "Does this message need attention today rather than in the normal queue?",
    {
      true: "Money is stuck, a deadline is at risk, or the customer has already been waiting without a reply.",
      false: "A routine question that can wait for the normal queue.",
    },
  ),
  is_money_blocked: noul(
    "Is the customer currently unable to access money they are owed, according to `message` and `waiting_days`?",
  ),
  topic: choice("Which single area does this message belong to?", {
    payouts: "Money owed to the customer is delayed, failed, or missing.",
    account_access: "The customer cannot sign in or is locked out.",
    billing: "A charge, invoice, or subscription amount is disputed.",
    other: "None of the above fits the message.",
  }),
  // Score criteria are an ORDERED list; the index is the score.
  frustration: score("How frustrated does the customer sound?", [
    "Neutral question or first report, no sign of impatience.",
    "Mentions waiting or a lack of response, but the tone stays civil.",
    "Explicitly complains about being ignored or uses charged language.",
    "Threatens to cancel, escalate publicly, or involve a regulator.",
  ]),
} as const;

// Evaluate these on your own data - they encode how costly each mistake is.
const THRESHOLDS = { act: 0.8, review: 0.45 } as const;

async function main(): Promise<void> {
  if (process.argv.includes("--dry-run")) {
    const model = process.env["TYPESAFE_DEFAULT_MODEL"] ?? "jev-latest";
    console.log(JSON.stringify({ model, state, questions }, null, 2));
    return;
  }

  const client = new TypeSafeClient();
  const { answers, usage, model } = await client.systemOne({ state, questions });

  // Typed by question: `.noul` on a noul, `.choice` on a choice, `.score` on a
  // score. Reading the wrong one is a compile error.
  console.log(`model:         ${model}`);
  console.log(`topic:         ${answers.topic.choice} (confidence ${answers.topic.confidence.toFixed(2)})`);
  console.log(`frustration:   ${answers.frustration.score.toFixed(2)} - ${nearestLevel(answers.frustration)}`);
  console.log(`urgent:        ${answers.is_urgent.noul.toFixed(2)} -> ${band(answers.is_urgent, THRESHOLDS)}`);
  console.log(`money blocked: ${answers.is_money_blocked.noul.toFixed(2)}`);
  console.log(`tokens:        ${usage.input_tokens} in / ${usage.output_tokens} out`);

  const route = band(answers.is_urgent, THRESHOLDS);
  console.log(
    route === "act"
      ? "\nrouting: page the on-call payouts engineer"
      : route === "review"
        ? "\nrouting: put in front of a human - the signal is genuinely unclear"
        : "\nrouting: normal queue",
  );
}

main().catch((err: unknown) => {
  if (err instanceof APIConnectionError) {
    console.error(
      `could not reach the API: ${err.message}\n` +
        "The request never completed, so this is not a credentials problem. " +
        "Check network access to the host, and proxy settings if you are behind one.",
    );
  } else if (err instanceof APIError) {
    console.error(`API error ${err.status ?? "?"}: ${err.message}`);
  } else if (err instanceof TypeSafeError) {
    console.error(`config: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
