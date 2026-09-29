import OpenAI from "openai";
const client = new OpenAI({apiKey:process.env.OPENAI_API_KEY});
export async function aiDecision(payload){
  if(!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const response=await client.responses.create({
    model:process.env.OPENAI_MODEL||"gpt-5.6-luna",
    instructions:"You are an XAUUSD SMC trading analyst. Technical evidence has 70% weight and fundamental evidence 30%. Never invent missing market data. Do not force a trade. Return ONLY valid JSON with keys decision (BUY, SELL, NO_TRADE), confidence (0-100), entry, stopLoss, takeProfit1, takeProfit2, technicalReason, fundamentalReason, invalidation. Use the supplied 12 CLOSED M5 candles and computed SMC features. If evidence conflicts or is weak, choose NO_TRADE. Risk levels must be derived from supplied price structure.",
    input:JSON.stringify(payload)
  });
  const text=response.output_text.trim().replace(/^\`\`\`json\s*/,"").replace(/\`\`\`$/,"");
  return JSON.parse(text);
}