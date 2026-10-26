export interface Topic {
	/** Stable key stored in `articles.topic` and used by `/articles?topic=`. */
	id: string;
	name: string;
	/** What counts as on-topic, given to Claude as search guidance. */
	brief: string;
}

export const TOPICS: Topic[] = [
	{
		id: 'llm-releases',
		name: 'New frontier LLM model versions',
		brief:
			'Newly launched or newly announced large language model versions from frontier AI labs ' +
			'(e.g. Anthropic, OpenAI, Google DeepMind, Meta, xAI, Mistral, DeepSeek, Alibaba Qwen, Moonshot). ' +
			'Only actual model releases or version updates: new model names/versions, general availability, ' +
			'major capability or pricing changes to a specific model. Exclude opinion pieces, rumours, ' +
			'funding news and generic AI commentary.',
	},
	{
		id: 'agentic-harnesses',
		name: 'Agentic AI harness developments',
		brief:
			'Developments in agentic AI harnesses and frameworks: coding agents and agent CLIs ' +
			'(e.g. Claude Code, Codex, Gemini CLI, Cursor, Devin), agent SDKs and frameworks ' +
			'(e.g. Claude Agent SDK, OpenAI Agents SDK, LangGraph, CrewAI), agent protocols (MCP, A2A), ' +
			'tool-use, memory, orchestration and evaluation infrastructure. Prefer release notes, launches ' +
			'and substantive technical announcements over general commentary.',
	},
	{
		id: 'autoimmune-liver',
		name: 'Autoimmune liver disease & cirrhosis treatments',
		brief:
			'The latest treatments for autoimmune-related liver disease - autoimmune hepatitis (AIH), ' +
			'primary biliary cholangitis (PBC), primary sclerosing cholangitis (PSC) - and for cirrhosis: ' +
			'regulatory approvals (FDA, EMA), clinical-trial results, new guidelines, and significant ' +
			'peer-reviewed research. Prefer primary and authoritative sources (journals, regulators, ' +
			'trial sponsors, medical news outlets) over consumer health content.',
	},
];
