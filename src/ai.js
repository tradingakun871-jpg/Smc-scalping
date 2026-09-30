import OpenAI from "openai";
function getClient(){
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  return new OpenAI({apiKey});
}
export async function aiDecision(payload){
  const client=getClient();
  const response=await client.responses.create({
    model:process.env.OPENAI_MODEL||"gpt-5.6-luna",
    instructions:"Anda adalah analis trading SMC XAUUSD. WAJIB gunakan Bahasa Indonesia untuk semua teks penjelasan/alasan yang dikembalikan (dailyBiasReason, h1Reason, m15Reason, m5Reason, technicalReason, fundamentalReason, entryReason, invalidation). Nama keputusan BUY, SELL, NO_TRADE serta angka harga tetap menggunakan format aslinya. Technical evidence has 70% weight and fundamental evidence 30%. Never invent missing market data. For HOURLY_D1_MTF_ANALYSIS, produce exactly one actionable directional entry decision on every newly CLOSED H1: BUY or SELL, never NO_TRADE. Choose the stronger direction from the supplied evidence even when mixed, reduce confidence when evidence is weak, and state conflicts/weaknesses explicitly. This hourly requirement applies only to HOURLY_D1_MTF_ANALYSIS; other modes may use NO_TRADE. Return ONLY valid JSON with keys decision (BUY, SELL, NO_TRADE), confidence (0-100), entry, stopLoss, takeProfit1, takeProfit2, dailyBiasReason, h1Reason, m15Reason, m5Reason, technicalReason, fundamentalReason, entryReason, invalidation. Untuk setiap BUY atau SELL, semua field alasan harus ringkas, jelas, spesifik berdasarkan bukti data yang diberikan, dan ditulis dalam Bahasa Indonesia. entryReason wajib menjelaskan KENAPA ENTRY SEKARANG dengan urutan: konteks D1 -> struktur H1 -> konfirmasi M15 -> trigger M5. Untuk NO_TRADE, jelaskan alasan WAIT/NO ENTRY dalam Bahasa Indonesia. Jangan gunakan alasan generik seperti setup valid. Use the supplied PREVIOUS CLOSED D1 candle as the daily context/bias and the supplied CLOSED H1, M15, and M5 market data for multi-timeframe SMC confirmation and execution. H1 defines intraday structure, M15 confirms the setup, and M5 is the execution timeframe. The daily bias is context, never permission to force a trade. Require liquidity/structure/OB-FVG/displacement/retest evidence from the supplied data. For HOURLY_D1_MTF_ANALYSIS, if timeframes conflict or evidence is weak, still choose the stronger BUY or SELL direction, use lower confidence, and explain the conflict. For other modes, choose NO_TRADE when the setup is incomplete or weak. Risk levels must be derived from supplied price structure.",
    input:JSON.stringify(payload)
  });
  const text=response.output_text.trim().replace(/^\`\`\`json\s*/,"").replace(/\`\`\`$/,"");
  return JSON.parse(text);
}