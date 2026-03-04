import { put, del } from "@vercel/blob";

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

      // ── STEP 1: Resemble Detect — real acoustic AI voice analysis ──
      let resembleScore = null;
      let resembleLabel = null;
      let resembleError = null;
      let blobUrl = null;

      if (RESEMBLE_KEY) {
        try {
          // Upload to Vercel Blob to get a public URL
          const blob = await put(
            `audio-scan-${Date.now()}.wav`,
            audioBuffer,
            { access: "public", contentType: "audio/wav" }
          );
          blobUrl = blob.url;

          // Send URL to Resemble Detect
          const formData = new FormData();
          formData.append("url", blobUrl);
          formData.append("privacy_mode", "true");

          const resembleRes = await fetch("https://app.resemble.ai/api/v2/detect", {
            method: "POST",
            headers: {
              Authorization: `Token ${RESEMBLE_KEY}`,
            },
            body: formData,
          });

          // Delete blob immediately after sending to Resemble
          try { await del(blobUrl); } catch (_) {}

          if (resembleRes.ok) {
            const rData = await resembleRes.json();
            // Resemble returns: { item: { score: 0.87, label: "AI", ... } }
            const item = rData.item || rData;
            resembleScore = item.score ?? item.ai_score ?? item.ai_probability ?? null;
            resembleLabel = item.label ?? (resembleScore > 0.5 ? "AI" : "HUMAN");
          } else {
            const errData = await resembleRes.json().catch(() => ({}));
            resembleError = errData.message || errData.error || `Resemble error ${resembleRes.status}`;
            console.error("Resemble Detect error:", resembleError);
          }
        } catch (e) {
          resembleError = e.message;
          // Clean up blob if upload succeeded but detection failed
          if (blobUrl) { try { await del(blobUrl); } catch (_) {} }
          console.error("Resemble exception:", e.message);
        }
      } else {
        resembleError = "RESEMBLE_API_KEY not configured";
      }

      // ── STEP 2: ElevenLabs STT — transcription ──
      let transcription = null;
      let transcriptionError = null;

      if (ELEVENLABS_KEY) {
        try {
          const elForm = new FormData();
          elForm.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
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

      // ── STEP 3: Return result with Resemble data ──
      if (resembleScore !== null) {
        const aiPct = Math.round(resembleScore * 100);
        const isAI = resembleLabel === "AI" || resembleScore > 0.5;
        const type = aiPct >= 65 ? "danger" : aiPct >= 35 ? "warn" : "safe";
        const verdict = aiPct >= 65 ? "fake" : aiPct >= 35 ? "misleading" : "real";

        return res.status(200).json({
          type,
          score: aiPct,
          verdict,
          title: isAI ? "AI-Generated Voice Detected" : "Voice Appears Authentic",
          desc: isAI
            ? `Resemble Detect identified synthetic voice acoustic characteristics with ${aiPct}% confidence. Frame-by-frame analysis revealed patterns associated with modern speech synthesis models.`
            : `Acoustic analysis found no significant evidence of artificial synthesis. The voice presents natural characteristics with only ${aiPct}% probability of being AI-generated.`,
          summary: isAI
            ? `Audio has high probability of being AI-generated (${aiPct}%).`
            : `Audio appears to be of human origin (${100 - aiPct}% human).`,
          transcription: transcription ? transcription.slice(0, 300) : null,
          signals: [
            {
              name: "Voice Origin",
              desc: isAI
                ? `Acoustic analysis detected artificial synthesis patterns with ${aiPct}% probability. Frequencies and cadences typical of AI-generated voice.`
                : `Acoustic patterns consistent with natural human voice. Low probability of artificial synthesis (${aiPct}% AI).`,
              pct: `${aiPct}%`,
              level: type,
            },
            {
              name: "Acoustic Analysis",
              desc: `Resemble AI DETECT-3B model analyzed ${isAI ? "neural synthesis artifacts" : "natural speech variations"} in the audio signal frame-by-frame.`,
              pct: `${aiPct}%`,
              level: type,
            },
            {
              name: "Speech Transcription",
              desc: transcription
                ? `"${transcription.slice(0, 120)}..."`
                : transcriptionError
                  ? `Transcription unavailable: ${transcriptionError}`
                  : "Add ELEVENLABS_API_KEY to enable transcription.",
              pct: transcription ? "OK" : "N/A",
              level: transcription ? "safe" : "neutral",
            },
            {
              name: "Content Analysis",
              desc: transcription
                ? "Transcription available. To verify spoken claims, copy the text and use text mode."
                : "Acoustic analysis complete. Transcription required to verify spoken content.",
              pct: "N/A",
              level: "neutral",
            },
          ],
        });
      }

      // ── STEP 4: Fallback — Resemble failed, use Claude on transcription ──
      if (transcription && transcription.trim().length > 0) {
        const audioPrompt = `You are a fact-checker for AuthentiScan Pro. Analyze this audio transcription for misinformation. Return ONLY valid JSON:

Transcription: """${transcription.slice(0, 3000)}"""

{
  "type": "warn",
  "score": 50,
  "title": "Audio Content Analysis",
  "desc": "2-3 sentences about credibility.",
  "verdict": "unverified",
  "summary": "One sentence conclusion.",
  "signals": [
    {"name": "Voice Origin", "desc": "Acoustic analysis unavailable — RESEMBLE_API_KEY required", "pct": "N/A", "level": "warn"},
    {"name": "Speech Transcription", "desc": "transcription excerpt here", "pct": "OK", "level": "safe"},
    {"name": "Audio Integrity", "desc": "coherence evaluation", "pct": "50%", "level": "warn"},
    {"name": "Content Analysis", "desc": "analysis of claims made", "pct": "60%", "level": "warn"}
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

      // ── STEP 5: Final fallback ──
      return res.status(200).json({
        type: "warn",
        score: 45,
        verdict: "unverified",
        title: "Configuration Incomplete",
        desc: !RESEMBLE_KEY
          ? "Add RESEMBLE_API_KEY and BLOB_READ_WRITE_TOKEN in Vercel to enable real acoustic AI voice detection."
          : `Detection failed: ${resembleError || "Unknown error"}`,
        summary: "Configure environment variables for complete analysis.",
        signals: [
          { name: "Voice Origin", desc: RESEMBLE_KEY ? (resembleError || "Error") : "RESEMBLE_API_KEY required.", pct: "N/A", level: "warn" },
          { name: "Acoustic Analysis", desc: "Requires Resemble Detect API + Vercel Blob.", pct: "N/A", level: "warn" },
          { name: "Speech Transcription", desc: ELEVENLABS_KEY ? (transcriptionError || "No speech detected") : "ELEVENLABS_API_KEY required.", pct: "N/A", level: "warn" },
          { name: "Content Analysis", desc: "Transcription required.", pct: "N/A", level: "warn" },
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
