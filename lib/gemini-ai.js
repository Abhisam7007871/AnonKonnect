import { getPersonaConfig } from "@/lib/demo-ai";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const API_BASE = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";

function mapHistoryToContents(history = []) {
  return history
    .filter((entry) => entry?.content)
    .slice(-12)
    .map((entry) => ({
      role: entry.role === "assistant" ? "model" : "user",
      parts: [{ text: String(entry.content) }],
    }));
}

function mapHistoryToOpenAIMessages(persona, history = [], message) {
  return [
    { role: "system", content: persona.systemInstruction },
    ...history
      .filter((entry) => entry?.content)
      .slice(-12)
      .map((entry) => ({
        role: entry.role === "assistant" ? "assistant" : "user",
        content: String(entry.content),
      })),
    { role: "user", content: String(message) },
  ];
}

function getOppositeGender(userGender) {
  const g = String(userGender || "").toLowerCase();
  if (g === "male") return "female";
  if (g === "female") return "male";
  return null;
}

function buildGenderSystemAddon(userGender) {
  const opposite = getOppositeGender(userGender);
  if (!opposite) {
    return "";
  }

  // Keep it short so the model stays concise.
  return `User gender: ${String(userGender).toLowerCase()}. Respond as a warm, playful ${opposite} persona.`;
}

function getSecondaryProviderConfig() {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const provider =
    process.env.XAI_PROVIDER || (apiKey.startsWith("gsk_") ? "groq" : "xai");
  const baseURL =
    process.env.XAI_API_BASE ||
    (provider === "groq" ? "https://api.groq.com/openai/v1" : "https://api.x.ai/v1");

  const configuredModel = process.env.XAI_MODEL || "grok-beta";
  const resolvedModel =
    provider === "groq" && configuredModel.toLowerCase().includes("grok")
      ? "llama-3.1-8b-instant"
      : configuredModel;

  return {
    provider,
    apiKey,
    model: resolvedModel,
    baseURL,
  };
}

function shouldFallbackToSecondary(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded") ||
    message.includes("fetch failed")
  );
}

function buildLocalFallbackReply({ personaId, message }) {
  const text = String(message || "").trim();
  const short = text.length > 90 ? `${text.slice(0, 90)}...` : text;

  if (personaId === "jokebot") {
    return `Bold take: "${short}" is giving main-character energy. I approve.`;
  }

  if (personaId === "roleplay") {
    return `A soft neon light flickers. "Interesting move," I whisper. Your turn.`;
  }

  return `Got you. "${short}" makes sense — what do you want to do next?`;
}

async function requestGemini({ personaId, message, history = [], userGender }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const persona = getPersonaConfig(personaId);
  const genderAddon = buildGenderSystemAddon(userGender);
  const effectiveSystemInstruction = genderAddon
    ? `${persona.systemInstruction}\n\n${genderAddon}`
    : persona.systemInstruction;

  const contents = mapHistoryToContents(history);
  contents.push({
    role: "user",
    parts: [{ text: String(message) }],
  });

  const response = await fetch(`${API_BASE}/models/${DEFAULT_MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: effectiveSystemInstruction }],
      },
      contents,
      generationConfig: {
        temperature: personaId === "jokebot" || personaId === "roleplay" ? 0.9 : 0.7,
        topP: 0.95,
        maxOutputTokens: 160,
      },
    }),
    cache: "no-store",
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage =
      payload?.error?.message || `Gemini request failed with status ${response.status}.`;
    throw new Error(errorMessage);
  }

  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  return {
    provider: "gemini",
    reply: text,
  };
}

async function requestSecondaryProvider({ personaId, message, history = [], userGender }) {
  const providerConfig = getSecondaryProviderConfig();
  if (!providerConfig) {
    throw new Error("Secondary AI provider is not configured.");
  }

  const persona = getPersonaConfig(personaId);
  const genderAddon = buildGenderSystemAddon(userGender);
  const effectiveSystemInstruction = genderAddon
    ? `${persona.systemInstruction}\n\n${genderAddon}`
    : persona.systemInstruction;

  const response = await fetch(`${providerConfig.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${providerConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: providerConfig.model,
      messages: mapHistoryToOpenAIMessages(
        { ...persona, systemInstruction: effectiveSystemInstruction },
        history,
        message,
      ),
      temperature: personaId === "jokebot" || personaId === "roleplay" ? 0.9 : 0.7,
      max_tokens: 160,
    }),
    cache: "no-store",
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage =
      payload?.error?.message ||
      payload?.error ||
      `${providerConfig.provider} request failed with status ${response.status}.`;
    throw new Error(errorMessage);
  }

  const text = payload?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error(`${providerConfig.provider} returned an empty response.`);
  }

  return {
    provider: providerConfig.provider,
    reply: text,
  };
}

export async function generatePersonaReply(input) {
  if (!process.env.GEMINI_API_KEY && !getSecondaryProviderConfig()) {
    return {
      provider: "local-fallback",
      reply: buildLocalFallbackReply(input || {}),
    };
  }

  try {
    return await requestGemini(input);
  } catch (error) {
    if (!getSecondaryProviderConfig() || !shouldFallbackToSecondary(error)) {
      throw error;
    }

    const secondaryResult = await requestSecondaryProvider(input);
    return {
      ...secondaryResult,
      fallbackFrom: "gemini",
    };
  }
}
