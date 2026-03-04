export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json({ status: "ok", message: "AuthentiScan API running" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
  const RESEMBLE_KEY = process.env.RESEMBLE_API_KEY;

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { text, audio, mode } = req.body || {};

  // ══════════════════════════════════════
  // AUDIO MODE
  // ══════════════════════════════════════
  if (mode === "audio" && audio) {
    try {
      const audioBuffer = Buffer.from(audio, "base64");

      // ── STEP 1: Resemble Detect — análise acústica real de voz IA ──
      let resembleScore = null;
      let resembleLabel = null;
      let resembleError = null;

      if (RESEMBLE_KEY) {
        try {
          const formData = new FormData();
          formData.append(
            "audio_file",
            new Blob([audioBuffer], { type: "audio/wav" }),
            "audio.wav"
          );
          formData.append("content_type", "audio");

          const resembleRes = await fetch("https://app.resemble.ai/api/v2/detect", {
            method: "POST",
            headers: {
              Authorization: `Token token=${RESEMBLE_KEY}`,
            },
            body: formData,
          });

          if (resembleRes.ok) {
            const rData = await resembleRes.json();
            resembleScore = rData.score ?? rData.ai_probability ?? rData.result?.score ?? null;
            resembleLabel = rData.label ?? rData.result?.label ?? (resembleScore > 0.5 ? "AI" : "HUMAN");
          } else {
            const errData = await resembleRes.json().catch(() => ({}));
            resembleError = errData.message || errData.error || `Resemble error ${resembleRes.status}`;
            console.error("Resemble Detect error:", resembleError);
          }
        } catch (e) {
          resembleError = e.message;
          console.error("Resemble Detect exception:", e.message);
        }
      } else {
        resembleError = "RESEMBLE_API_KEY not configured";
      }

      // ── STEP 2: ElevenLabs STT — transcrição ──
      let transcription = null;
      let transcriptionError = null;

      if (ELEVENLABS_KEY) {
        try {
          const elForm = new FormData();
          elForm.append(
            "file",
            new Blob([audioBuffer], { type: "audio/wav" }),
            "audio.wav"
          );
          elForm.append("model_id", "scribe_v1");

          const elRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
            method: "POST",
            headers: { "xi-api-key": ELEVENLABS_KEY },
            body: elForm,
          });

          if (elRes.ok) {
            const elData = await elRes.json();
            transcription = elData.text || elData.transcription || null;
          } else {
            const errData = await elRes.json().catch(() => ({}));
            transcriptionError = errData.detail?.message || `ElevenLabs error ${elRes.status}`;
          }
        } catch (e) {
          transcriptionError = e.message;
        }
      }

      // ── STEP 3: Resultado com dados do Resemble ──
      if (resembleScore !== null) {
        const aiPct = Math.round(resembleScore * 100);
        const isAI = resembleLabel === "AI" || resembleScore > 0.5;
        const type = aiPct >= 65 ? "danger" : aiPct >= 35 ? "warn" : "safe";
        const verdict = aiPct >= 65 ? "fake" : aiPct >= 35 ? "misleading" : "real";

        return res.status(200).json({
          type,
          score: aiPct,
          verdict,
          title: isAI ? "Voz Gerada por IA Detectada" : "Voz Parece Autêntica",
          desc: isAI
            ? `Resemble Detect identificou características acústicas de voz sintética com ${aiPct}% de confiança. A análise frame-a-frame revelou padrões associados a modelos modernos de síntese de fala.`
            : `A análise acústica não encontrou evidências de síntese artificial. A voz apresenta características naturais com apenas ${aiPct}% de probabilidade de ser IA.`,
          summary: isAI
            ? `Áudio com alta probabilidade de ser gerado por IA (${aiPct}%).`
            : `Áudio aparenta ser de origem humana (${100 - aiPct}% humano).`,
          transcription: transcription ? transcription.slice(0, 300) : null,
          signals: [
            {
              name: "Voice Origin",
              desc: isAI
                ? `Análise acústica detectou padrões de síntese artificial com ${aiPct}% de probabilidade.`
                : `Padrões acústicos consistentes com voz humana natural (${aiPct}% probabilidade de IA).`,
              pct: `${aiPct}%`,
              level: type,
            },
            {
              name: "Acoustic Analysis",
              desc: `Modelo DETECT-3B da Resemble AI analisou ${isAI ? "artefatos de síntese neural" : "variações naturais de fala"} no sinal de áudio frame-a-frame.`,
              pct: `${aiPct}%`,
              level: type,
            },
            {
              name: "Speech Transcription",
              desc: transcription
                ? `"${transcription.slice(0, 120)}..."`
                : transcriptionError
                  ? `Transcrição indisponível: ${transcriptionError}`
                  : "Adicione ELEVENLABS_API_KEY para transcrição.",
              pct: transcription ? "OK" : "N/A",
              level: transcription ? "safe" : "neutral",
            },
            {
              name: "Content Analysis",
              desc: transcription
                ? "Transcrição disponível. Para verificação de afirmações, copie o texto e use o modo texto."
                : "Análise acústica concluída. Transcrição necessária para verificar o conteúdo falado.",
              pct: "N/A",
              level: "neutral",
            },
          ],
        });
      }

      // ── STEP 4: Fallback com Claude se Resemble falhou mas há transcrição ──
      if (transcription && transcription.trim().length > 0) {
        const audioPrompt = `Você é verificador de fatos do AuthentiScan Pro. Analise esta transcrição de áudio. Retorne APENAS JSON válido:

Transcrição: """${transcription.slice(0, 3000)}"""

{
  "type": "warn",
  "score": 50,
  "title": "Análise de Conteúdo de Áudio",
  "desc": "2-3 frases sobre credibilidade.",
  "verdict": "unverified",
  "summary": "Uma frase com a conclusão.",
  "signals": [
    {"name": "Voice Origin", "desc": "Análise acústica indisponível — RESEMBLE_API_KEY necessária", "pct": "N/A", "level": "warn"},
    {"name": "Speech Transcription", "desc": "trecho da transcrição", "pct": "OK", "level": "safe"},
    {"name": "Audio Integrity", "desc": "avaliação de coerência", "pct": "50%", "level": "warn"},
    {"name": "Content Analysis", "desc": "análise das afirmações feitas", "pct": "60%", "level": "warn"}
  ]
}`;

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
            messages: [{ role: "user", content: audioPrompt }],
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const fullText = data.content.filter(b => b.type === "text").map(b => b.text).join("");
          const clean = fullText.replace(/```json|```/g, "").trim();
          const jsonMatch = clean.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const analysis = JSON.parse(jsonMatch[0]);
            analysis.transcription = transcription.slice(0, 300);
            return res.status(200).json(analysis);
          }
        }
      }

      // ── STEP 5: Fallback final ──
      return res.status(200).json({
        type: "warn",
        score: 45,
        verdict: "unverified",
        title: "Configuração Incompleta",
        desc: !RESEMBLE_KEY
          ? "Adicione RESEMBLE_API_KEY no Vercel para habilitar detecção acústica real de voz IA."
          : `Detecção falhou: ${resembleError || "Erro desconhecido"}`,
        summary: "Configure as variáveis de ambiente para análise completa.",
        signals: [
          { name: "Voice Origin", desc: RESEMBLE_KEY ? (resembleError || "Erro") : "RESEMBLE_API_KEY necessária.", pct: "N/A", level: "warn" },
          { name: "Acoustic Analysis", desc: "Requer Resemble Detect API.", pct: "N/A", level: "warn" },
          { name: "Speech Transcription", desc: ELEVENLABS_KEY ? (transcriptionError || "Sem fala detectada") : "ELEVENLABS_API_KEY necessária.", pct: "N/A", level: "warn" },
          { name: "Content Analysis", desc: "Transcrição necessária.", pct: "N/A", level: "warn" },
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

Content: """${text.slice(0, 3000)}"""

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
    const fullText = data.content.filter(b => b.type === "text").map(b => b.text).join("");
    const clean = fullText.replace(/```json|```/g, "").trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");

    return res.status(200).json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    return res.status(500).json({
      error: err.message,
      detail: "Check ANTHROPIC_API_KEY in Vercel environment variables",
    });
  }
}
