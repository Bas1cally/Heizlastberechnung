/**
 * Worked example: triage one inbound support message.
 *
 * All four questions are independent judgments over the same state, so they go
 * out in a single request and are judged in parallel. Only add a second request
 * when an answer is needed to fetch new evidence or to decide the next options.
 *
 *   npm run triage -- --dry-run   prints the request without sending it
 *   npm run triage                sends it (needs TYPESAFE_API_KEY and a
 *                                 reachable host)
 */

import {
  ApiError,
  ConfigError,
  DecisionsClient,
  NetworkError,
  band,
  buildRequestBody,
  choice,
  configFromEnv,
  noul,
  score,
} from "../index.js";

const state = {
  channel: "email",
  waiting_days: 3,
  replies_from_us: 0,
  message: "My payouts have failed for three days and nobody has replied.",
};

const questions = {
  is_urgent: noul({
    instructions:
      "Does this message need urgent attention, meaning it should be handled today rather than in the normal queue?",
  }),
  is_money_blocked: noul({
    instructions:
      "Is the customer currently unable to access money they are owed, according to `message` and `waiting_days`?",
  }),
  topic: choice({
    instructions:
      "Which single area does this message belong to, judged by what the customer needs resolved?",
    criteria: {
      payouts: "Money owed to the customer is delayed, failed, or missing.",
      account_access: "The customer cannot sign in or is locked out.",
      billing: "A charge, invoice, or subscription amount is disputed.",
      other: "None of the above fits the message.",
    },
  }),
  frustration: score({
    instructions:
      "How frustrated does the customer sound, judged from their wording and how long they have waited?",
    criteria: {
      calm: "A neutral question or a first report, with no sign of impatience.",
      irritated:
        "Mentions waiting or a lack of response, but the tone stays civil.",
      angry:
        "Explicitly complains about being ignored, repeats a prior contact, or uses charged language.",
      leaving:
        "Threatens to cancel, escalate publicly, or involve a regulator or lawyer.",
    },
  }),
} as const;

// Evaluate these on your own data - they encode how costly each mistake is,
// not anything about the model.
const THRESHOLDS = { act: 0.8, review: 0.45 } as const;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    const model = process.env["TYPESAFE_MODEL"] ?? "jev-latest";
    console.log(JSON.stringify(JSON.parse(buildRequestBody(model, state, questions)), null, 2));
    return;
  }

  const client = new DecisionsClient(configFromEnv());
  const answers = await client.decide(state, questions);

  // Typed without a cast: `.probability` on a noul, `.value` on a choice,
  // `.level` on a score. Misreading one is a compile error.
  console.log(`topic:        ${answers.topic.value} (confidence ${answers.topic.confidence.toFixed(2)})`);
  console.log(`frustration:  ${answers.frustration.level}`);
  console.log(`urgent:       p=${answers.is_urgent.probability.toFixed(2)} -> ${band(answers.is_urgent, THRESHOLDS)}`);
  console.log(`money blocked:p=${answers.is_money_blocked.probability.toFixed(2)}`);

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
  if (err instanceof ConfigError) {
    console.error(`config: ${err.message}`);
  } else if (err instanceof NetworkError || err instanceof ApiError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
