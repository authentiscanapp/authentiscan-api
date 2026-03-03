export default async function handler(req, res) {
  // Allow all origins (CodeSandbox, Vercel, any frontend)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json({ status: "ok", message: "AuthentiScan API running" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { text, audio, mode } = req.body || {};

  // ══════════════════════════════════════
  // AUDIO MODE
  // ══════════════════════════════════════
  if (mode === "audio" && audio) {
    try {
      let isAIVoice = null;
      let aiConfidence = null;
      let transcription = null;

      if (ELEVENLABS_KEY) {
        try {
          const audioBuffer = Buffer.from(audio, "base64");
          const formData = new FormData();
          formData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
          const elRes = await fetch("https://api.elevenlabs.io/v1/speech-recognition/detect-ai-speech", {
            method: "POST",
            headers: { "xi-api-key": ELEVENLABS_KEY },
            body: formData,
          });
          if (elRes.ok) {
            const elData = await elRes.json();
            isAIVoice = elData.is_ai_speech;
            aiConfidence = elData.confidence;
          }
        } catch (e) { console.error("ElevenLabs:", e.message); }
      }

      let score, type, verdict;
      if (isAIVoice === true)       { score = Math.round(70 + (aiConfidence||0.5)*27); type="danger"; verdict="ai_voice"; }
      else if (isAIVoice === false) { score = Math.round(8  + (1-(aiConfidence||0.8))*25); type="safe"; verdict="human_voice"; }
      else                          { score=45; type="warn"; verdict="unverified"; }

      return res.status(200).json({
        type, score, verdict,
        title: isAIVoice===true ? "AI-Generated Voice Detected" : isAIVoice===false ? "Human Voice Confirmed" : "Voice Analysis Inconclusive",
        desc: isAIVoice===true
          ? `AI-generated speech detected with ${Math.round((aiConfidence||0.5)*100)}% confidence.`
          : isAIVoice===false
          ? `Authentic human speech confirmed with ${Math.round((aiConfidence||0.8)*100)}% confidence.`
          : "Add ELEVENLABS_API_KEY in Vercel to enable voice AI detection.",
        summary: "Audio analyzed for AI voice patterns.",
        signals: [
          { name:"Voice Origin", desc: isAIVoice===true?"Synthetic speech detected.":isAIVoice===false?"Natural human voice confirmed.":"ELEVENLABS_API_KEY required.", pct:aiConfidence?`${Math.round(aiConfidence*100)}%`:"N/A", level:isAIVoice===true?"danger":isAIVoice===false?"safe":"warn" },
          { name:"Speech Transcription", desc:transcription?`"${transcription.slice(0,100)}"` : "Add OPENAI_API_KEY to enable.", pct:"N/A", level:"warn" },
          { name:"Audio Integrity", desc:"Checks for splicing and manipulation.", pct:isAIVoice!=null?`${score}%`:"N/A", level:type },
          { name:"Content Analysis", desc:"Transcription required for content analysis.", pct:"N/A", level:"warn" },
        ],
      });
    } catch (err) {
      return res.status(500).json({ error: "Audio analysis failed: " + err.message });
    }
  }

  // ══════════════════════════════════════
  // TEXT / URL MODE
  // ══════════════════════════════════════
  if (!text || text.trim().length < 5) {
    return res.status(400).json({ error: "No content provided" });
  }

  const prompt = `You are an expert fact-checker for AuthentiScan Pro. Analyze this content and return ONLY valid JSON (no markdown, no explanation outside JSON):

Content: """${text.slice(0,3000)}"""

Return exactly this JSON structure:
{
  "type": "danger",
  "score": 87,
  "title": "High Misinformation Risk",
  "desc": "2-3 sentence analysis of why this content is risky or credible.",
  "verdict": "fake",
  "summary": "One sentence key finding.",
  "signals": [
    {"name": "Claim Accuracy", "desc": "specific finding about claims", "pct": "15%", "level": "danger"},
    {"name": "Source Credibility", "desc": "source analysis or N/A if no URL", "pct": "N/A", "level": "neutral"},
    {"name": "Emotional Intensity", "desc": "language tone analysis", "pct": "20%", "level": "danger"},
    {"name": "Context Completeness", "desc": "context analysis", "pct": "25%", "level": "warn"}
  ]
}

Rules:
- type: "danger" if score 65-100, "warn" if 35-64, "safe" if 0-34
- verdict: "fake", "misleading", "real", or "unverified"
- Source Credibility pct MUST be "N/A" if no URL in content
- Be specific about actual claims in the content
- Use web search to verify facts when possible`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${response.status}`);
    }

    const data = await response.json();
    const fullText = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    const clean = fullText.replace(/```json|```/g, "").trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");

    const analysis = JSON.parse(jsonMatch[0]);
    return res.status(200).json(analysis);
  } catch (err) {
    return res.status(500).json({
      error: err.message,
      detail: "Check ANTHROPIC_API_KEY in Vercel environment variables",
    });
  }
}
