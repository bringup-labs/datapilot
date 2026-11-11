const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI",
  google: "Gemini (Google)",
  ollama: "Ollama (local)",
  nvidia: "NVIDIA NIM",
  custom: "Custom (OpenAI-compatible)",
};

/** The provider's name as Settings shows it; an unknown id is returned as is. */
export function providerDisplayName(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}
