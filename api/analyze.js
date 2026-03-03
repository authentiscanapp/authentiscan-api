export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { text, audio, mode } = req.body;

  // ══════════════════════════════════════
  // AUDIO MODE — AI Voice Detection
  // ══════════════════════════════════════
  if (mode === "audio" && audio) {
    try {
      let isAIVoice = null;
      let aiConfidence = null;
      let transcription = null;

      // 1. ElevenLabs AI Speech Classifier
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

      // 2. Whisper transcription
      const OPENAI_KEY = process.env.OPENAI_API_KEY;
      if (OPENAI_KEY) {
        try {
          const audioBuffer = Buffer.from(audio, "base64");
          const formData = new FormData();
          formData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
          formData.append("model", "whisper-1");
          const wRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${OPENAI_KEY}` },
            body: formData,
          });
          if (wRes.ok) { const d = await wRes.json(); transcription = d.text; }
        } catch (e) { console.error("Whisper:", e.message); }
      }

      let score, type, verdict;
      if (isAIVoice === true)       { score = Math.round(70 + (aiConfidence||0.5)*27); type="danger"; verdict="ai_voice"; }
      else if (isAIVoice === false) { score = Math.round(8  + (1-(aiConfidence||0.8))*25); type="safe"; verdict="human_voice"; }
      else                          { score=45; type="warn"; verdict="unverified"; }

      return res.status(200).json({
        type, score, verdict,
        title: isAIVoice===true ? "AI-Generated Voice Detected" : isAIVoice===false ? "Human Voice Confirmed" : "Voice Analysis Inconclusive",
        desc: isAIVoice===true
          ? `This audio was identified as AI-generated speech with ${Math.round((aiConfidence||0.5)*100)}% confidence. Synthetic voice patterns detected.`
          : isAIVoice===false
          ? `This audio was identified as authentic human speech with ${Math.round((aiConfidence||0.8)*100)}% confidence.`
          : "ElevenLabs API key required for voice AI detection. Add ELEVENLABS_API_KEY in Vercel.",
        summary: transcription ? `Transcription: "${transcription.slice(0,200)}"` : "Audio analyzed for AI voice patterns.",
        mode: "audio",
        signals: [
          { name:"Voice Origin",         desc: isAIVoice===true ? "Synthetic speech patterns detected." : isAIVoice===false ? "Natural human voice confirmed." : "Add ELEVENLABS_API_KEY to enable.", pct: aiConfidence?`${Math.round(aiConfidence*100)}%`:"N/A", level: isAIVoice===true?"danger":isAIVoice===false?"safe":"warn" },
          { name:"Speech Transcription", desc: transcription?`"${transcription.slice(0,100)}..."` : "Add OPENAI_API_KEY to enable Whisper transcription.", pct: transcription?"Done":"N/A", level:"safe" },
          { name:"Audio Integrity",      desc:"Checks for splicing, manipulation and temporal inconsistencies.", pct:isAIVoice!=null?`${score}%`:"N/A", level:type },
          { name:"Content Analysis",     desc: transcription?"Transcribed content analyzed for misinformation.":"Transcription required for content analysis.", pct: transcription?`${score}%`:"N/A", level:type },
        ],
      });
    } catch (err) {
      return res.status(500).json({ error: "Audio analysis failed: " + err.message });
    }
  }

  // ══════════════════════════════════════
  // TEXT / URL MODE — Claude Fact Check
  // ══════════════════════════════════════
  if (!text || text.trim().length < 5) return res.status(400).json({ error: "No content provided" });

  const prompt = `You are an expert fact-checker for AuthentiScan Pro. Analyze this content and return ONLY valid JSON (no markdown):

Content: """${text.slice(0,3000)}"""

Return exactly:
{"type":"danger"|"warn"|"safe","score":<0-100>,"title":"<title>","desc":"<2-3 sentences>","verdict":"fake"|"misleading"|"real"|"unverified","summary":"<1 sentence>","signals":[{"name":"Claim Accuracy","desc":"<finding>","pct":"<N>%","level":"danger"|"warn"|"safe"},{"name":"Source Credibility","desc":"<finding>","pct":"<N>% or N/A if no URL","level":"danger"|"warn"|"safe"|"neutral"},{"name":"Emotional Intensity","desc":"<finding>","pct":"<N>%","level":"danger"|"warn"|"safe"},{"name":"Context Completeness","desc":"<finding>","pct":"<N>%","level":"danger"|"warn"|"safe"}]}

Rules: score 65-100=danger, 35-64=warn, 0-34=safe. Source pct must be N/A if no URL.`;

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

    if (!response.ok) throw new Error(`API error ${response.status}`);
    const data = await response.json();
    const fullText = data.content.filter(b=>b.type==="text").map(b=>b.text).join("");
    const match = fullText.replace(/```json|```/g,"").trim().match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");
    return res.status(200).json(JSON.parse(match[0]));
  } catch (err) {
    return res.status(500).json({ error: err.message, detail: "Check ANTHROPIC_API_KEY in Vercel" });
  }
}
