/**
 * One command that says whether the setup actually works: `npm run check`.
 *
 * Three steps, cheapest first, so a failure points at one thing:
 *   1. is a key configured at all          (no request)
 *   2. can we reach the API and authenticate (models list - costs no tokens)
 *   3. does a real judgment come back       (one noul - costs a few tokens)
 */

import { TypeSafeClient, noul } from "@typesafe-ai/sdk";
import { describeFailure } from "./typesafe/diagnose.js";
import { loadEnvFile } from "./typesafe/env.js";

loadEnvFile();

const tick = (msg: string) => console.log(`  ok    ${msg}`);
const cross = (msg: string) => console.log(`  FAIL  ${msg}`);

function fail(step: string, err: unknown): never {
  const { headline, remedy } = describeFailure(err);
  cross(`${step}: ${headline}`);
  console.log(`\n${remedy}`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log("Checking the TypeSafe setup\n");

  if (!process.env["TYPESAFE_API_KEY"]?.trim()) {
    cross("no API key");
    console.log("\nSet TYPESAFE_API_KEY. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  tick("API key is set");

  let client: TypeSafeClient;
  try {
    client = new TypeSafeClient();
  } catch (err) {
    fail("client config", err);
  }
  tick(`base URL ${client.baseURL}, default model ${client.defaultModel}`);

  // Costs no tokens, so it isolates "can I reach and authenticate" from
  // "does inference work".
  try {
    const models = await client.models.list();
    tick(`reached the API and authenticated (${models.length} model(s) available)`);
    for (const m of models) console.log(`        - ${m.name}`);
  } catch (err) {
    fail("reach and authenticate", err);
  }

  try {
    const { answers, usage, model } = await client.systemOne({
      state: "The payment failed and the customer is waiting.",
      questions: { is_urgent: noul("Does this need attention today?") },
    });
    tick(
      `judgment returned by ${model}: is_urgent = ${answers.is_urgent.noul.toFixed(2)} ` +
        `(${usage.input_tokens} in / ${usage.output_tokens} out)`,
    );
  } catch (err) {
    fail("run a judgment", err);
  }

  console.log("\nEverything works. Try: npm run triage");
}

main().catch((err: unknown) => fail("unexpected", err));
