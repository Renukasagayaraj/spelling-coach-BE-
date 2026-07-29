import assert from "node:assert/strict";
import test, { mock } from "node:test";

const openAIModels: any[] = [];
const anthropicModels: any[] = [];
const agents: any[] = [];

class ChatOpenAI {
  options: any;
  constructor(options: any) { this.options = options; openAIModels.push(this); }
  async invoke() { return "openai"; }
}
class ChatAnthropic {
  options: any;
  constructor(options: any) { this.options = options; anthropicModels.push(this); }
  async invoke() { return "anthropic"; }
}
const createDeepAgent = mock.fn((options: any) => {
  const agent = { options, invoke: async () => "agent" };
  agents.push(agent);
  return agent;
});
class OpenAI {
  options: any;
  constructor(options: any) { this.options = options; }
}

mock.module("@langchain/openai", { namedExports: { ChatOpenAI } });
mock.module("@langchain/anthropic", { namedExports: { ChatAnthropic } });
mock.module("deepagents", { namedExports: { createDeepAgent } });
mock.module("openai", { defaultExport: OpenAI });

const agent = await import("../agent.js");
const direct = await import("../directModel.js");
const config = await import("../modelConfig.js");
const openai = await import("../openaiClient.js");

test.beforeEach(() => {
  process.env.OPENAI_API_KEY = "openai-key";
  process.env.ANTHROPIC_API_KEY = "anthropic-key";
  delete process.env.SPELLING_COACH_MODEL;
});

test("model configuration handles defaults, overrides, and OpenAI temperature", () => {
  assert.equal(config.getConfiguredModelName(), config.DEFAULT_MODEL_NAME);
  process.env.SPELLING_COACH_MODEL = " anthropic:claude-test ";
  assert.equal(config.getConfiguredModelName(), " anthropic:claude-test ");
  assert.equal(config.getOpenAITemperature("openai:gpt-5-mini"), 1);
  assert.equal(config.getOpenAITemperature("openai:gpt-4.1-mini"), 0);
});

test("direct models support object injection, OpenAI, Anthropic, and caching", async () => {
  const injected = { invoke: async () => "injected" };
  assert.equal(await direct.createDirectSpellingCoachModel({ model: injected }), injected);

  const first = await direct.createDirectSpellingCoachModel({ model: "openai:gpt-5-mini" });
  const cached = await direct.createDirectSpellingCoachModel({ model: "openai:gpt-5-mini" });
  assert.equal(first, cached);
  assert.equal(openAIModels.at(-1).options.model, "gpt-5-mini");
  assert.equal(openAIModels.at(-1).options.temperature, 1);

  const anthropic = await direct.createDirectSpellingCoachModel({ model: "anthropic:claude-test" });
  assert.equal(anthropicModels.at(-1).options.model, "claude-test");
  assert.equal(await anthropic.invoke(null), "anthropic");
  assert.match(direct.buildDirectRuntimeSystemPrompt(), /single direct model response/);
});

test("agent creation resolves models, injects constraints, and caches string models", async () => {
  const factory = await agent.getCreateDeepAgent();
  assert.equal(factory, createDeepAgent);
  assert.equal(await agent.getCreateDeepAgent(), factory);

  const first = await agent.createSpellingCoachAgent({ model: "openai:gpt-4.1-mini" });
  const cached = await agent.createSpellingCoachAgent({ model: "openai:gpt-4.1-mini" });
  assert.equal(first, cached);
  assert.match(agents.at(-1).options.instructions, /No persistence/);

  await agent.createSpellingCoachAgent({ model: "claude-plain" });
  assert.equal(anthropicModels.at(-1).options.model, "claude-plain");

  const injected = { invoke: async () => "custom" };
  const custom = await agent.createSpellingCoachAgent({ model: injected });
  assert.equal(agents.at(-1).options.model, injected);
  assert.equal(await custom.invoke(null), "agent");
});

test("OpenAI client validates its API key and caches the SDK instance", () => {
  delete process.env.OPENAI_API_KEY;
  assert.throws(() => openai.getOpenAIClient(), /OPENAI_API_KEY is required/);
  process.env.OPENAI_API_KEY = "sdk-key";
  const first = openai.getOpenAIClient();
  assert.equal((first as any).options.apiKey, "sdk-key");
  assert.equal(openai.getOpenAIClient(), first);
});
